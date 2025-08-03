import { Button, Chip, Paper, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid2';
import React, { MouseEvent,useEffect, useState } from 'react';

interface Props {
  label: string;
  placeholder: string;
  value: string[];
  onChange: (value: string[]) => void;
  defaultValue?: string;
}

const ListInput:React.FC<Props> = ({ label, value, onChange, defaultValue, placeholder }) => {
  const [ inputValue, setInputValue ] = useState<string>(defaultValue || '');
  const [ addItem, setAddItem ] = useState(false);

  useEffect(() => {
    if (!addItem) {
      setInputValue(defaultValue || '');
    }
  }, [ addItem ]);

  const handleAdd = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (value && !value.includes(inputValue)) {
      onChange([...value, inputValue]);
      setAddItem(false);
    }
  }

  return (<Grid size={12}>
    <Paper
      sx={{
        display: 'flex',
        justifyContent: 'center',
        flexWrap: 'wrap',
        listStyle: 'none',
        p: 2,
        mb: 1,
      }}
    >
      {value.length > 0 && value.map((item) =>
        <Chip
          sx={{ ml: 1, mb: 1 }}
          onDelete={() => onChange(value.filter(v => v !== item))}
          key={item}
          label={item}
        />
      ) || <Typography variant="body2">No {label} added</Typography>}
      <Grid size={12} sx={{ mt: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {!addItem && <Button
          sx={{ alignSelf: 'center' }}
          variant="outlined"
          onClick={() => setAddItem(true)}
        >
          Add {label}
        </Button>}
        {addItem && <>
        <TextField
          fullWidth
          label={label}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder={placeholder}
        />
        <Button
          disabled={!inputValue || value.includes(inputValue)}
          sx={{ ml: 2}}
          variant="outlined"
          onClick={handleAdd}
        >Add</Button>
        <Button
          sx={{ ml: 2}}
          variant="outlined"
          onClick={() => setAddItem(false)}
        >Cancel</Button>
        </>}
      </Grid>
    </Paper>
  </Grid>)
}

export default ListInput;