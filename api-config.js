/** Shared OpenAI API key stored in localStorage (see settings.html). */
var OPENAI_API_KEY_STORAGE_KEY = 'practice-mode-openai-api-key';

function getOpenAiApiKey() {
  try {
    return (localStorage.getItem(OPENAI_API_KEY_STORAGE_KEY) || '').trim();
  } catch (_) {
    return '';
  }
}
