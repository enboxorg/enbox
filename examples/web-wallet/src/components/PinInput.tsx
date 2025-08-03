import Grid from '@mui/material/Grid2';
import React, { createRef, useEffect } from 'react';
import { TextField } from '@mui/material';
import { useState } from 'react';

interface PinInputProps {
  initialPin: string[];
  onPinChange: (updatedPin: string[]) => void;
}

const PinInput: React.FC<PinInputProps> = ({ initialPin, onPinChange }) => {
  const [pin, setPin] = useState(initialPin);
  const firstInputRef = createRef<HTMLInputElement>();

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const onDigitInputChange = (digitIndex: number) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;

    // Allow only numbers
    if (!/^\d*$/.test(value)) return;

    const newPin = [...pin];
    newPin[digitIndex] = value;
    setPin(newPin);

    // Move focus to the next input
    if (value && digitIndex < initialPin.length - 1) {
      const nextInput = document.getElementById(`pin-${digitIndex + 1}`);
      nextInput?.focus();
    }

    onPinChange(newPin);
  };

  const onDigitInputKeyDown = (digitIndex: number) => (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !pin[digitIndex] && digitIndex > 0) {
      const prevInput = document.getElementById(`pin-${digitIndex - 1}`);
      prevInput?.focus();
    }
  };

  return (
    <Grid container spacing={2} justifyContent="center">
      {pin.map((digit, digitIndex) => (
        <Grid key={digitIndex}>
          <TextField
            id={`pin-${digitIndex}`}
            variant="outlined"
            value={digit}
            onChange={onDigitInputChange(digitIndex)}
            onKeyDown={onDigitInputKeyDown(digitIndex)}
            sx={{
              width: 60,
              height: 60,
              '& .MuiInputBase-input': {
                textAlign: 'center', // Center the text
              },
            }}
            inputRef={digitIndex === 0 ? firstInputRef : undefined}
            slotProps={{
              htmlInput: {
                inputMode: 'numeric',
                maxLength: 1, // ensures only 1 digit
              }
            }}
          />
        </Grid>
      ))}
    </Grid>
  );
};

export default PinInput;
