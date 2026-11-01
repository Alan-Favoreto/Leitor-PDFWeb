"""Aplicação aiohttp: API de voz (/api/tts…) + arquivos estáticos de web/ (e só de web/)."""

from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import socket
from pathlib import Path
from urllib.parse import urlsplit

from aiohttp import web

from .config import WEB_DIR
from .engines import EngineError
from .service import Cancelled, TTSService

log = logging.getLogger('servidor')

SERVICE_KEY = web.AppKey('service', TTSService)
ALLOWED_HOSTS_KEY = web.AppKey('allowed_hosts', frozenset)
TASKS_KEY = web.AppKey('tasks', list)

MAX_JSON_BYTES = 16 * 1024
POST_ONLY = ('/api/tts', '/api/tts/unload')
CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
}


# ---------------------------------------------------------------------- utilidades
def _dumps(obj) -> str:
    return json.dumps(obj, ensure_ascii=False)


def json_response(data, status: int = 200, **kwargs) -> web.Response:
    return web.json_response(data, status=status, dumps=_dumps, **kwargs)


def json_error(status: int, message: str, code: str) -> web.Response:
    return json_response({'error': message, 'code': code}, status=status,
                         headers={'Cache-Control': 'no-store'})


def _host_only(value: str) -> str:
    """'Localhost:8090' → 'localhost'; '[::1]:8090' → '::1'."""
    value = value.strip().lower()
    if value.startswith('['):
        end = value.find(']')
        return value[1:end] if end > 0 else value
    if value.count(':') == 1:
        return value.split(':', 1)[0]
    return value


def _local_addresses() -> set[str]:
    names: set[str] = set()
    try:
        hostname = socket.gethostname()
        names.update({hostname.lower(), f'{hostname.lower()}.local'})
        for info in socket.getaddrinfo(hostname, None):
            names.add(str(info[4][0]).split('%', 1)[0].lower())
    except OSError:
        pass
    try:  # IP usado para sair para a rede (não envia nada; UDP só escolhe a rota)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('192.0.2.1', 9))
            names.add(s.getsockname()[0])
    except OSError:
        pass
    return names


def build_allowed_hosts(bind_host: str, extra: list[str]) -> frozenset:
    allowed = {'localhost', '127.0.0.1', '::1'}
    allowed.update(h.strip().lower() for h in extra if isinstance(h, str) and h.strip())
    bind = bind_host.strip().lower()
    if bind in ('0.0.0.0', '::', ''):
        allowed.update(_local_addresses())
    else:
        allowed.add(_host_only(bind) if not bind.count(':') > 1 else bind)
    return frozenset(allowed)


def lan_urls(port: int) -> list[str]:
    urls = []
    for addr in sorted(_local_addresses()):
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            continue
        if ip.version == 4 and not ip.is_loopback and not ip.is_link_local:
            urls.append(f'http://{addr}:{port}')
    return urls


# ---------------------------------------------------------------------- middlewares
@web.middleware
async def security_middleware(request: web.Request, handler):
    is_api = request.path.startswith('/api/')
    # 1) DNS rebinding: só aceita Host conhecido
    host = request.headers.get('Host', '')
    if not host or _host_only(host) not in request.app[ALLOWED_HOSTS_KEY]:
        log.warning('Pedido recusado: Host "%s" não permitido.', host[:80])
        if is_api:
            return json_error(403, 'Endereço (Host) não permitido.', 'FORBIDDEN_HOST')
        return web.Response(status=403, text='Host não permitido.')
    # 2) CSRF: métodos que mudam estado só com Origin igual ao Host (ou sem Origin)
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        origin = request.headers.get('Origin')
        site = request.headers.get('Sec-Fetch-Site', '')
        bad = site == 'cross-site'
        if origin is not None:
            parts = urlsplit(origin)
            bad = bad or parts.scheme not in ('http', 'https') or \
                parts.netloc.lower() != host.strip().lower()
        if bad:
            log.warning('Pedido recusado: origem "%s" diferente do servidor.', (origin or site)[:80])
            return json_error(403, 'Origem do pedido não permitida.', 'FORBIDDEN_ORIGIN')
    try:
        response = await handler(request)
    except web.HTTPException as exc:
        if is_api and exc.status >= 400:
            messages = {404: ('Rota não encontrada.', 'NOT_FOUND'),
                        405: ('Método não permitido nesta rota.', 'METHOD_NOT_ALLOWED'),
                        413: ('Pedido grande demais.', 'PAYLOAD_TOO_LARGE')}
            message, code = messages.get(exc.status, (exc.reason or 'Erro.', 'HTTP_ERROR'))
            return json_error(exc.status, message, code)
        raise
    except Exception:  # noqa: BLE001 - nunca devolver traceback ao navegador
        log.exception('Erro inesperado em %s %s', request.method, request.path)
        if is_api:
            return json_error(500, 'Erro interno no servidor. Veja o terminal.', 'INTERNAL')
        return web.Response(status=500, text='Erro interno no servidor.')
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('Referrer-Policy', 'no-referrer')
    response.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    if is_api:
        response.headers.setdefault('Cache-Control', 'no-store')
        response.headers.setdefault('Cross-Origin-Resource-Policy', 'same-origin')
    return response


# ---------------------------------------------------------------------- API
async def handle_status(request: web.Request) -> web.Response:
    return json_response(request.app[SERVICE_KEY].status())


async def handle_voices(request: web.Request) -> web.Response:
    service = request.app[SERVICE_KEY]
    engine = request.query.get('engine')
    if engine is not None and engine not in service.engines:
        return json_error(400, 'Motor de voz desconhecido.', 'ENGINE_UNKNOWN')
    return json_response({'voices': service.voices(engine)})


async def _read_json(request: web.Request, *, required: bool = True) -> dict:
    if request.content_length is not None and request.content_length > MAX_JSON_BYTES:
        raise EngineError('Pedido grande demais.', 'PAYLOAD_TOO_LARGE', 413)
    raw = await request.content.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise EngineError('Pedido grande demais.', 'PAYLOAD_TOO_LARGE', 413)
    if not raw.strip():
        if required:
            raise EngineError('Corpo JSON ausente.', 'BAD_JSON', 400)
        return {}
    if request.content_type != 'application/json':
        raise EngineError('Envie o corpo como application/json.', 'BAD_CONTENT_TYPE', 415)
    try:
        data = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, ValueError) as exc:
        raise EngineError('JSON inválido.', 'BAD_JSON', 400) from exc
    if not isinstance(data, dict):
        raise EngineError('O corpo precisa ser um objeto JSON.', 'BAD_JSON', 400)
    return data


async def handle_tts(request: web.Request) -> web.Response:
    service = request.app[SERVICE_KEY]
    try:
        data = await _read_json(request)
        text, lang, engine, voice = service.resolve(
            data.get('text'), data.get('lang'), data.get('voice'), data.get('engine'))

        def gave_up() -> bool:
            transport = request.transport
            return transport is None or transport.is_closing()

        audio, from_cache = await service.synthesize(text, lang, engine, voice, gave_up)
    except EngineError as exc:
        return json_error(exc.status, exc.message, exc.code)
    except Cancelled:
        return json_error(503, 'Pedido cancelado.', 'CANCELLED')
    return web.Response(
        body=audio.wav,
        content_type='audio/wav',
        headers={
            'X-Audio-Duration': f'{audio.duration:.3f}',
            'X-Engine': audio.engine,
            'X-Voice': audio.voice,
            'X-Lang': audio.lang,
            'X-Cache': 'hit' if from_cache else 'miss',
        },
    )


async def handle_unload(request: web.Request) -> web.Response:
    service = request.app[SERVICE_KEY]
    try:
        data = await _read_json(request, required=False)
    except EngineError as exc:
        return json_error(exc.status, exc.message, exc.code)
    engine = data.get('engine')
    if engine is not None and engine not in service.engines:
        return json_error(400, 'Motor de voz desconhecido.', 'ENGINE_UNKNOWN')
    unloaded = await service.unload(engine)
    return json_response({'ok': True, 'unloaded': unloaded})


# ---------------------------------------------------------------------- site estático
async def handle_static(request: web.Request) -> web.StreamResponse:
    tail = request.match_info.get('tail', '')
    if tail.startswith('api/') or tail == 'api':
        if request.path in POST_ONLY:
            raise web.HTTPMethodNotAllowed(request.method, ['POST'])
        raise web.HTTPNotFound()
    parts = [p for p in tail.split('/') if p]
    if any(p.startswith('.') or '\\' in p or ':' in p for p in parts):
        raise web.HTTPNotFound()
    root: Path = WEB_DIR.resolve()
    target = root.joinpath(*parts) if parts else root
    try:
        target = target.resolve(strict=True)
        target.relative_to(root)
    except (OSError, ValueError):
        raise web.HTTPNotFound() from None
    if target.is_dir():
        if parts and not tail.endswith('/'):
            raise web.HTTPFound(f'/{"/".join(parts)}/')
        target = target / 'index.html'
        if not target.is_file():
            raise web.HTTPNotFound()
    if not target.is_file():
        raise web.HTTPNotFound()
    ctype = CONTENT_TYPES.get(target.suffix.lower(), 'application/octet-stream')
    return web.FileResponse(target, headers={'Content-Type': ctype, 'Cache-Control': 'no-cache'})


# ---------------------------------------------------------------------- montagem
def create_app(service: TTSService, bind_host: str, extra_hosts: list[str],
               preload: bool = False) -> web.Application:
    app = web.Application(middlewares=[security_middleware], client_max_size=64 * 1024)
    app[SERVICE_KEY] = service
    app[ALLOWED_HOSTS_KEY] = build_allowed_hosts(bind_host, extra_hosts)
    app[TASKS_KEY] = []
    app.router.add_get('/api/tts/status', handle_status)
    app.router.add_get('/api/tts/voices', handle_voices)
    app.router.add_post('/api/tts', handle_tts)
    app.router.add_post('/api/tts/unload', handle_unload)
    app.router.add_get('/{tail:.*}', handle_static)

    async def on_startup(app_: web.Application) -> None:
        service.start()
        if preload:  # em segundo plano: o site já responde enquanto o modelo carrega
            app_[TASKS_KEY].append(asyncio.get_running_loop().create_task(service.preload()))

    async def on_cleanup(_app: web.Application) -> None:
        await service.close()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app
