import React, { useState } from 'react';
import { useBackupSeed } from '../contexts/Context';

const BackupSeedPhrase: React.FC = () => {
  const { backupSeed, removeBackupSeed } = useBackupSeed();
  const [isBlurred, setIsBlurred] = useState(true);
  const [showDeleteWarning, setShowDeleteWarning] = useState(false);

  const toggleBlur = () => setIsBlurred(!isBlurred);

  const copyToClipboard = () => {
    if (backupSeed) {
      navigator.clipboard.writeText(backupSeed);
      alert('Seed phrase copied to clipboard!');
    }
  };

  const deleteSeedPhrase = () => {
    removeBackupSeed();
    setShowDeleteWarning(false);
  };

  if (!backupSeed) {
    return <p className="text-center mt-8">No backup seed phrase exists.</p>;
  }

  return (
    <div>
      <div>
        <div>
          <h2>Backup Seed Phrase</h2>
          <div>
            {backupSeed.split(' ').map((word, index) => (
              <span key={index}>
                {word}
              </span>
            ))}
          </div>
          <div>
            <button
              onClick={toggleBlur}
            >
              {isBlurred ? 'Reveal' : 'Blur'} Phrase
            </button>
            <button
              onClick={copyToClipboard}
            >
              Copy Phrase
            </button>
            <button
              onClick={() => setShowDeleteWarning(true)}
            >
              Delete Phrase
            </button>
          </div>
          {showDeleteWarning && (
            <div>
              <p>Are you sure you want to delete the seed phrase?</p>
              <div>
                <button
                  onClick={() => setShowDeleteWarning(false)}
                >
                  Cancel
                </button>
                <button
                  onClick={deleteSeedPhrase}
                >
                  Confirm Delete
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default BackupSeedPhrase;
