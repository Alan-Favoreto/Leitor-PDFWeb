"""Ponto de entrada: `python -m servidor [opções]`.

Exemplos:
  python -m servidor                      # http://localhost:8090, Kokoro sob demanda
  python -m servidor --preload            # já carrega o motor padrão ao iniciar
  python -m servidor --engine chatterbox  # motor padrão = Chatterbox
  python -m servidor --host 0.0.0.0       # abre na rede local (cuidado: qualquer um da rede usa)
  python -m servidor --baixar-modelos     # só baixa os modelos e sai
  python -m servidor --testar             # gera frases de teste e mede o tempo
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
import time
import warnings
import webbrowser

from . import __version__
from .config import WEB_DIR, load_config

log = logging.getLogger('servidor')

TEST_SENTENCES = {
    'pt': ('A leitura em voz alta ajuda a revisar textos longos: você escuta o ritmo das frases '
           'e percebe repetições que passariam despercebidas na tela.'),
    'en': ('Reading aloud helps you review long documents: you hear the rhythm of each sentence '
           'and notice repetitions that would slip by on the screen.'),
    'es': ('La lectura en voz alta ayuda a revisar textos largos: escuchas el ritmo de las frases '
           'y notas repeticiones que pasarían desapercibidas en la pantalla.'),
}


def setup_logging(verbose: bool) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors='replace')
        except (AttributeError, ValueError):
            pass
    # nosso logger escreve no terminal; o das bibliotecas só mostra avisos e erros
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(logging.Formatter('%(asctime)s  %(message)s', datefmt='%H:%M:%S'))
    log.addHandler(handler)
    log.setLevel(logging.DEBUG if verbose else logging.INFO)
    log.propagate = False
    logging.basicConfig(level=logging.INFO if verbose else logging.WARNING,
                        format='%(asctime)s  [%(name)s] %(message)s', datefmt='%H:%M:%S',
                        stream=sys.stderr)
    for noisy in ('aiohttp.access', 'httpx', 'huggingface_hub', 'urllib3', 'filelock',
                  'numba', 'phonemizer', 'jieba', 'matplotlib', 'diffusers', 'transformers'):
        logging.getLogger(noisy).setLevel(logging.WARNING if not verbose else logging.INFO)
    if not verbose:
        warnings.filterwarnings('ignore')
        os.environ.setdefault('TRANSFORMERS_VERBOSITY', 'error')
        os.environ.setdefault('TQDM_DISABLE', '1')


def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog='python -m servidor',
        description='Servidor local de voz neural do Leitor de PDF (serve o site de web/ + API).')
    p.add_argument('--host', help='endereço de escuta (padrão 127.0.0.1; 0.0.0.0 = rede local)')
    p.add_argument('--port', type=int, help='porta (padrão 8090)')
    p.add_argument('--engine', choices=['kokoro', 'chatterbox'], help='motor padrão')
    p.add_argument('--device', choices=['auto', 'cuda', 'cpu'], help='onde rodar o modelo')
    p.add_argument('--preload', action='store_true', help='carrega o motor padrão ao iniciar')
    p.add_argument('--idle-unload-minutes', type=float, metavar='MIN',
                   help='descarrega o modelo após MIN minutos sem uso (0 = nunca; padrão 10)')
    p.add_argument('--abrir', action='store_true', help='abre o navegador quando ficar pronto')
    p.add_argument('--baixar-modelos', action='store_true',
                   help='só baixa os modelos dos motores instalados e sai')
    p.add_argument('--testar', action='store_true',
                   help='carrega cada motor, gera frases de teste, mostra os tempos e sai')
    p.add_argument('--saida', metavar='PASTA', help='com --testar: salva os WAVs nesta pasta')
    p.add_argument('--verbose', '-v', action='store_true', help='mostra mensagens de depuração')
    p.add_argument('--version', action='version', version=f'%(prog)s {__version__}')
    return p.parse_args(argv)


def build_config(args: argparse.Namespace) -> dict:
    cfg = load_config()
    if args.host:
        cfg['host'] = args.host
    if args.port:
        cfg['port'] = args.port
    if args.engine:
        cfg['default_engine'] = args.engine
    if args.device:
        cfg['device'] = args.device
    if args.preload:
        cfg['preload'] = True
    if args.idle_unload_minutes is not None:
        cfg['idle_unload_minutes'] = max(0.0, args.idle_unload_minutes)
    if not (1 <= int(cfg['port']) <= 65535):
        raise SystemExit('Porta inválida.')
    return cfg


def make_service(cfg: dict):
    from .service import TTSService, detect_device

    log.info('Verificando a placa de vídeo…')
    device, gpu, total = detect_device(cfg['device'])
    if device == 'cuda':
        log.info('GPU: %s (%.0f GB), usando CUDA.', gpu, total or 0)
    else:
        log.info('Sem GPU NVIDIA utilizável: usando a CPU (funciona, mas é mais lento).')
    service = TTSService(cfg, device, gpu, total)
    for eid, engine in service.engines.items():
        if eid in service.unavailable:
            log.info('Motor %s: indisponível. %s', engine.name, service.unavailable[eid])
        else:
            log.info('Motor %s: disponível (%s).', engine.name, ', '.join(engine.languages))
    return service


# ---------------------------------------------------------------------- modos sem servidor
def download_models(service, only: str | None) -> int:
    failures = 0
    for engine in service.available_engines():
        if only and engine.id != only:
            continue
        log.info('Baixando/conferindo os arquivos de %s…', engine.name)
        t0 = time.perf_counter()
        try:
            service.run_blocking(engine.download)
            log.info('%s: modelos prontos (%.0f s).', engine.name, time.perf_counter() - t0)
        except Exception as exc:  # noqa: BLE001
            failures += 1
            log.error('Falha ao baixar %s: %s', engine.name, exc)
    return 1 if failures else 0


def self_test(service, only: str | None, out_dir: str | None) -> int:
    from .service import fmt

    failures = 0
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    for engine in service.available_engines():
        if only and engine.id != only:
            continue
        print()
        log.info('=== Teste: %s ===', engine.name)
        try:
            t0 = time.perf_counter()
            service.run_blocking(service._ensure_loaded, engine)  # noqa: SLF001
            load_s = time.perf_counter() - t0
            if service.device == 'cuda':
                import torch
                torch.cuda.reset_peak_memory_stats()
            for lang, sentence in TEST_SENTENCES.items():
                if lang not in engine.languages:
                    continue
                voice = engine.default_voice(lang)
                t1 = time.perf_counter()
                item = service.run_blocking(service._job, engine, voice, lang, sentence,  # noqa: SLF001
                                            lambda: False)
                gen_s = time.perf_counter() - t1
                rtf = gen_s / item.duration if item.duration else 0
                log.info('  %s: %d caract. → %s s de áudio em %s s (fator tempo real %s)',
                         lang, len(sentence), fmt(item.duration), fmt(gen_s, 2), fmt(rtf, 2))
                if out_dir:
                    path = os.path.join(out_dir, f'{engine.id}_{lang}_{voice.id.split(":")[1]}.wav')
                    with open(path, 'wb') as fh:
                        fh.write(item.wav)
                    log.info('     salvo em %s', path)
            extra = ''
            if service.device == 'cuda':
                import torch
                extra = (f', pico de VRAM do PyTorch {fmt(torch.cuda.max_memory_allocated() / 1024**3)}'
                         ' GB')
            log.info('%s OK: carregou em %s s%s.', engine.name, fmt(load_s), extra)
        except Exception as exc:  # noqa: BLE001
            failures += 1
            msg = getattr(exc, 'message', None) or f'{type(exc).__name__}: {exc}'
            log.error('%s FALHOU: %s', engine.name, msg)
        finally:
            service.run_blocking(service._unload, [engine.id], 'fim do teste')  # noqa: SLF001
    print()
    if failures:
        log.error('Teste terminou com %d falha(s).', failures)
    else:
        log.info('Teste concluído sem erros.')
    return 1 if failures else 0


# ---------------------------------------------------------------------- servidor
async def serve(cfg: dict, service, open_browser: bool) -> None:
    from aiohttp import web

    from .app import create_app, lan_urls

    host, port = cfg['host'], int(cfg['port'])
    app = create_app(service, host, cfg.get('allowed_hosts', []), preload=bool(cfg['preload']))
    runner = web.AppRunner(app, access_log=None, handle_signals=False)
    await runner.setup()
    site = web.TCPSite(runner, host, port)
    try:
        await site.start()
    except OSError as exc:
        await runner.cleanup()
        raise SystemExit(f'Não consegui abrir a porta {port} em {host} ({exc.strerror or exc}). '
                         f'Ela já está em uso? Feche o outro programa ou use --port {port + 1}.')
    shown = 'localhost' if host in ('127.0.0.1', '0.0.0.0', '::', 'localhost') else host
    url = f'http://{shown}:{port}'
    log.info('Servidor pronto em %s  (Ctrl+C para parar)', url)
    if host in ('0.0.0.0', '::'):
        for lan in lan_urls(port):
            log.info('Na rede local: %s', lan)
        log.warning('Atenção: aberto na rede; qualquer aparelho da rede pode usar a voz.')
    idle = cfg['idle_unload_minutes']
    when = 'já está carregando' if cfg['preload'] else 'carrega no primeiro pedido'
    if idle:
        log.info('O modelo %s e é descarregado após %s min sem uso.', when,
                 f'{idle:g}'.replace('.', ','))
    else:
        log.info('O modelo %s e fica na memória até fechar o servidor.', when)
    if not (WEB_DIR / 'index.html').is_file():
        log.warning('Não achei %s; só a API vai funcionar.', WEB_DIR / 'index.html')
    if open_browser:
        webbrowser.open(url)
    try:
        await asyncio.Event().wait()
    finally:
        await runner.cleanup()


def main(argv=None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)
    cfg = build_config(args)
    log.info('Leitor de PDF com voz: servidor %s (Python %s)', __version__,
             sys.version.split()[0])
    try:
        service = make_service(cfg)
    except ImportError as exc:
        log.error('Dependência ausente (%s). Rode o instalador: scripts\\instalar.bat '
                  '(Windows) ou scripts/instalar.sh (Linux).', exc)
        return 1
    if args.baixar_modelos:
        return download_models(service, args.engine)
    if args.testar:
        return self_test(service, args.engine, args.saida)
    try:
        asyncio.run(serve(cfg, service, args.abrir))
    except KeyboardInterrupt:
        pass
    log.info('Servidor encerrado.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
