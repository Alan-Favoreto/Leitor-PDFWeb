// Abrir PDF pelo botão (seletor de arquivos) ou arrastando e soltando na janela inteira.

/**
 * true se o arquivo parece ser um PDF (pelo tipo ou pela extensão).
 * @param {File | null | undefined} file
 */
export function isPdfFile(file) {
  if (!file) return false;
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

function hasFiles(event) {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes('Files'));
}

/**
 * Liga o seletor de arquivos e o arrastar e soltar.
 * @param {object} options
 * @param {HTMLInputElement} options.fileInput input type="file" (escondido)
 * @param {HTMLElement[]} [options.openButtons] botões que abrem o seletor
 * @param {HTMLElement} [options.overlay] camada mostrada enquanto o arquivo é arrastado
 * @param {EventTarget} [options.dropTarget=window] onde aceitar o arquivo solto
 * @param {(file: File) => void} options.onFile chamado com um PDF
 * @param {(file: File | null) => void} [options.onReject] chamado quando o arquivo não é PDF
 * @returns {{ openPicker(): void, destroy(): void }}
 */
export function setupFileDrop({
  fileInput,
  openButtons = [],
  overlay,
  dropTarget = window,
  onFile,
  onReject = () => {},
}) {
  const controller = new AbortController();
  const opts = { signal: controller.signal };
  let dragDepth = 0;

  const showOverlay = (visible) => {
    if (overlay) overlay.hidden = !visible;
  };

  const handleFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const pdf = files.find(isPdfFile);
    if (pdf) onFile(pdf);
    else onReject(files[0] ?? null);
  };

  const openPicker = () => fileInput.click();

  openButtons.forEach((button) => button.addEventListener('click', openPicker, opts));

  fileInput.addEventListener(
    'change',
    () => {
      handleFiles(fileInput.files);
      // Limpa para que escolher o mesmo arquivo de novo também dispare 'change'.
      fileInput.value = '';
    },
    opts,
  );

  dropTarget.addEventListener(
    'dragenter',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      showOverlay(true);
    },
    opts,
  );

  dropTarget.addEventListener(
    'dragover',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    opts,
  );

  dropTarget.addEventListener(
    'dragleave',
    (event) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      // relatedTarget nulo = o cursor saiu da janela.
      if (dragDepth === 0 || event.relatedTarget === null) {
        dragDepth = 0;
        showOverlay(false);
      }
    },
    opts,
  );

  dropTarget.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      showOverlay(false);
      handleFiles(event.dataTransfer.files);
    },
    opts,
  );

  // Se o arraste for cancelado (Esc, soltar fora da janela), some com a camada.
  window.addEventListener(
    'dragend',
    () => {
      dragDepth = 0;
      showOverlay(false);
    },
    opts,
  );

  return {
    openPicker,
    destroy: () => {
      controller.abort();
      showOverlay(false);
    },
  };
}
