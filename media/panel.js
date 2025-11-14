(function () {
  const vscode = acquireVsCodeApi();

  const selectModelButton = document.getElementById('selectModelButton');
  const sendButton = document.getElementById('sendPromptButton');
  const promptInput = document.getElementById('promptInput');
  const responseContainer = document.getElementById('responseContainer');
  const statusLine = document.getElementById('statusLine');
  const modelLabel = document.getElementById('modelLabel');

  const state = {
    busy: false
  };

  selectModelButton?.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectModel' });
  });

  sendButton?.addEventListener('click', () => {
    const prompt = promptInput?.value.trim();
    if (!prompt) {
      showStatus('Please enter a prompt before sending.', true);
      return;
    }

    vscode.postMessage({ type: 'sendPrompt', prompt });
  });

  promptInput?.addEventListener('input', () => {
    updateSendButtonState();
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message) {
      return;
    }

    switch (message.type) {
      case 'modelChanged':
        updateModelLabel(message.body?.label || 'No model selected');
        break;
      case 'responseStart':
        beginResponse();
        break;
      case 'responseChunk':
        appendChunk(message.body?.chunk || '');
        break;
      case 'responseComplete':
        completeResponse(message.body?.modelLabel);
        break;
      case 'responseError':
        failResponse(message.body?.message || 'Unknown error occurred.');
        break;
      default:
        break;
    }
  });

  function setBusy(isBusy) {
    state.busy = isBusy;
    if (selectModelButton) {
      selectModelButton.disabled = isBusy;
    }
    if (sendButton) {
      sendButton.disabled = isBusy || !promptInput?.value.trim();
    }
    if (promptInput) {
      promptInput.disabled = isBusy;
    }
  }

  function updateSendButtonState() {
    if (!sendButton) {
      return;
    }
    sendButton.disabled = state.busy || !promptInput?.value.trim();
  }

  function beginResponse() {
    setBusy(true);
    responseContainer?.classList.remove('empty');
    if (responseContainer) {
      responseContainer.innerHTML = '';
    }
    showStatus('Contacting language model…');
  }

  function appendChunk(text) {
    if (!responseContainer || !text) {
      return;
    }

    const fragments = text.split('\n');
    fragments.forEach((fragment, index) => {
      responseContainer.appendChild(document.createTextNode(fragment));
      if (index < fragments.length - 1) {
        responseContainer.appendChild(document.createElement('br'));
      }
    });
  }

  function completeResponse(modelLabelText) {
    setBusy(false);
    showStatus(modelLabelText ? `Response from ${modelLabelText}` : 'Response complete.');
  }

  function failResponse(message) {
    setBusy(false);
    showStatus(message, true);
  }

  function showStatus(text, isError = false) {
    if (!statusLine) {
      return;
    }
    statusLine.textContent = text;
    statusLine.classList.toggle('error', !!isError);
  }

  function updateModelLabel(labelText) {
    if (!modelLabel) {
      return;
    }
    modelLabel.textContent = labelText;
  }

  updateSendButtonState();
})();
