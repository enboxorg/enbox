import React, { useState, useEffect, useRef } from 'react';
import { bip39WordList } from '@/lib/utils';

interface SeedPhraseInputProps {
  value: string;
  onChange: (value: string) => void;
}

const SeedPhraseInput: React.FC<SeedPhraseInputProps> = ({ value, onChange }) => {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [currentWord, setCurrentWord] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (currentWord) {
      const matchedWords = bip39WordList.filter(word => word.startsWith(currentWord.toLowerCase()));
      setSuggestions(matchedWords.slice(0, 5));
    } else {
      setSuggestions([]);
    }
  }, [currentWord]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    const words = newValue.split(' ');
    const lastWord = words[words.length - 1];
    
    let validValue = '';
    if (newValue.length < value.length) {
      // Deletion occurred
      const oldWords = value.split(' ');
      validValue = oldWords.filter(word => bip39WordList.some(validWord => validWord.startsWith(word.toLowerCase()))).join(' ');
      if (lastWord && !bip39WordList.some(validWord => validWord.startsWith(lastWord.toLowerCase()))) {
        validValue += validValue ? ' ' + lastWord : lastWord;
      }
    } else {
      // Addition occurred
      validValue = words.filter(word => bip39WordList.some(validWord => validWord.startsWith(word.toLowerCase()))).join(' ');
      if (lastWord && !bip39WordList.some(validWord => validWord.startsWith(lastWord.toLowerCase()))) {
        validValue += validValue ? ' ' + lastWord : lastWord;
      }
    }
    
    onChange(validValue);
    
    const cursorPos = e.target.selectionStart || 0;
    setCursorPosition(cursorPos);

    const currentWordIndex = validValue.slice(0, cursorPos).split(' ').length - 1;
    setCurrentWord(words[currentWordIndex] || '');
  };

  const handleSuggestionClick = (word: string) => {
    const words = value.split(' ');
    const currentWordIndex = value.slice(0, cursorPosition).split(' ').length - 1;
    words[currentWordIndex] = word;
    const newValue = words.join(' ') + ' '; // Add space after the selected word
    onChange(newValue);
    setCurrentWord('');
    setSuggestions([]);
    textareaRef.current?.focus();
    // Set cursor position after the newly added space
    setTimeout(() => {
      const newCursorPosition = newValue.length;
      textareaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition);
    }, 0);
  };

  return (
    <div className="relative">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleInputChange}
        rows={4}
        placeholder="Enter your recovery phrase..."
      />
      <div>
        {value.split(' ').map((word, index) => (
          <React.Fragment key={index}>
            {index > 0 && ' '}
            <span>
              {word}
            </span>
          </React.Fragment>
        ))}
      </div>
      {suggestions.length > 0 && (
        <div>
          {suggestions.map((word, index) => (
            <div
              key={index}
              onClick={() => handleSuggestionClick(word)}
            >
              {word}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SeedPhraseInput;
