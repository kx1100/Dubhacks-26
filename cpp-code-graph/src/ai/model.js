'use strict';

// Access to a language model through VS Code's Language Model API.

const vscode = require('vscode');

/** The best available chat model (Claude, then GPT-4/5 class, then anything), or null. */
async function selectModel() {
  let models = [];
  try {
    models = await vscode.lm.selectChatModels();
  } catch {
    models = [];
  }
  if (!models.length) return null;
  return models.find(m => /claude/i.test(m.family || m.id)) || models.find(m => /gpt-4|gpt-5|o\d/i.test(m.family || '')) || models[0];
}

/** Sends one user prompt and calls onText with the accumulated text as it streams. Returns the full text. */
async function streamText(model, prompt, token, onText) {
  const messages = [vscode.LanguageModelChatMessage.User(prompt)];
  const response = await model.sendRequest(messages, { justification: 'Answer questions about the C/C++ code graph.' }, token);
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
    onText(text);
  }
  return text;
}

/** True for errors raised by the model request itself (as opposed to bugs in our code). */
function isModelError(err) {
  return err instanceof vscode.LanguageModelError || !!(err && err.code);
}

module.exports = { selectModel, streamText, isModelError };
