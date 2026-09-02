const SpellChecker = require('simple-spellchecker');

let dictionary = null;

const replacements = [
  [/\bmousee\b/gi, 'mouse'],
  [/\bmose\b/gi, 'mouse'],
  [/\bmousse\b/gi, 'mouse'],
  [/\bkeybord\b/gi, 'keyboard'],
  [/\bkeybaord\b/gi, 'keyboard'],
  [/\bmoniter\b/gi, 'monitor'],
  [/\bmonitr\b/gi, 'monitor'],
  [/\bprintar\b/gi, 'printer'],
  [/\bprinterr\b/gi, 'printer'],
  [/\bscannar\b/gi, 'scanner'],
  [/\bscaner\b/gi, 'scanner'],
  [/\binternate\b/gi, 'internet'],
  [/\binternettt\b/gi, 'internet'],
  [/\bwifi\b/gi, 'Wi-Fi'],
  [/\bwi fi\b/gi, 'Wi-Fi'],
  [/\bconection\b/gi, 'connection'],
  [/\bconnecton\b/gi, 'connection'],
  [/\bavilable\b/gi, 'available'],
  [/\bavialable\b/gi, 'available'],
  [/\bsoftwere\b/gi, 'software'],
  [/\bhardwere\b/gi, 'hardware'],
  [/\bsystm\b/gi, 'system'],
  [/\bsytem\b/gi, 'system'],
  [/\bcomputr\b/gi, 'computer'],
  [/\bcompuer\b/gi, 'computer'],
  [/\blaptp\b/gi, 'laptop'],
  [/\bladptop\b/gi, 'laptop'],
  [/\bwrking\b/gi, 'working'],
  [/\bwroking\b/gi, 'working'],
  [/\bpropery\b/gi, 'properly'],
  [/\bproparly\b/gi, 'properly'],
  [/\bplz\b/gi, 'please'],
  [/\bpls\b/gi, 'please'],
  [/\breq\b/gi, 'request'],
  [/\bprob\b/gi, 'problem'],
  [/\bprblm\b/gi, 'problem'],
  [/\bdoesnt\b/gi, 'does not'],
  [/\bdon't\b/gi, 'do not'],
  [/\bcant\b/gi, 'cannot'],
  [/\bcan't\b/gi, 'cannot'],
  [/\burjent\b/gi, 'urgent'],
  [/\bissue in\b/gi, 'issue with'],
];

const knownWords = new Set([
  'admin',
  'subadmin',
  'hod',
  'mrv',
  'met',
  'wifi',
  'wi-fi',
  'pc',
  'cpu',
  'ups',
  'lan',
  'erp',
  'id',
]);

const getDictionary = () => {
  if (!dictionary) {
    dictionary = SpellChecker.getDictionarySync('en-US');
  }
  return dictionary;
};

const stripHtml = (value) => String(value || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ');

const applyCommonCorrections = (value) => {
  let text = String(value || '');
  replacements.forEach(([pattern, replacement]) => {
    text = text.replace(pattern, replacement);
  });
  return text;
};

const preserveCase = (source, correction) => {
  if (source.toUpperCase() === source) return correction.toUpperCase();
  if (source.charAt(0).toUpperCase() === source.charAt(0)) {
    return correction.charAt(0).toUpperCase() + correction.slice(1);
  }
  return correction;
};

const chooseSuggestion = (word, suggestions) => {
  const lower = word.toLowerCase();
  const safeSuggestions = (suggestions || [])
    .filter((suggestion) => suggestion && suggestion[0]?.toLowerCase() === lower[0])
    .filter((suggestion) => Math.abs(suggestion.length - lower.length) <= 3);

  return safeSuggestions[0] || null;
};

const correctSpelling = (value) => {
  const spell = getDictionary();

  return String(value || '').replace(/[A-Za-z][A-Za-z'-]*/g, (word) => {
    const lower = word.toLowerCase();
    if (word.length <= 2 || knownWords.has(lower) || /\d/.test(word)) return word;
    if (spell.spellCheck(word) || spell.spellCheck(lower)) return word;

    const suggestion = chooseSuggestion(lower, spell.getSuggestions(lower, 5, 2));
    return suggestion ? preserveCase(word, suggestion) : word;
  });
};

const rephraseSentence = (value = '') => {
  let text = stripHtml(value)
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();

  text = applyCommonCorrections(text);
  text = correctSpelling(text);
  text = text.replace(/\bnot working\b/gi, 'is not working');
  text = text.replace(/\bnot available\b/gi, 'is not available');
  text = text.replace(/\bis is not working\b/gi, 'is not working');
  text = text.replace(/\bis is not available\b/gi, 'is not available');
  text = text.replace(/\bi\b/g, 'I');

  if (!text) return '';

  text = text.charAt(0).toUpperCase() + text.slice(1);

  if (!/[.!?]$/.test(text)) {
    text += '.';
  }

  return text;
};

module.exports = {
  rephraseSentence,
};
