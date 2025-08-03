import { Box, Dialog, Typography } from "@mui/material";
import { PortableIdentity } from "@enbox/agent";
import React, { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useIdentities } from "./Context";
import { useNotifications } from "@toolpad/core";

interface DragOverProps {
  identities: PortableIdentity[];
  setIdentities: React.Dispatch<React.SetStateAction<PortableIdentity[]>>;
  processFile: (file: File) => void;
}

export const DragOverIdentitiesContext = React.createContext<DragOverProps>({
  identities: [],
  setIdentities: () => {},
  processFile: () => {},
});

export const DragOverIdentitiesProvider:React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const notifications = useNotifications();
  const { identities: existingIdentities } = useIdentities();

  const [ dragOver, setDragOver ] = useState(false);
  const [ identities, setIdentities ] = useState<PortableIdentity[]>([]);

  const processFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = async (e) => {
      if (!e.target?.result) return;
      const portableIdentity = JSON.parse(e.target.result as string) as PortableIdentity;

      // make sure that the identity is not already imported
      if (existingIdentities.find((i) => i.didUri === portableIdentity.metadata.uri)) {
        notifications.show(`${portableIdentity.metadata.uri} already exists`, { autoHideDuration: 2600 });
        return;
      }

      // make sure the incoming identity list is unique
      if (identities.find((i) => i.metadata.uri === portableIdentity.metadata.uri)) {
        notifications.show(`${portableIdentity.metadata.uri} already exists in import list`, { autoHideDuration: 2600 });
      } else {
        setIdentities((identities) => [...identities, portableIdentity]);
      }
    }
    reader.readAsText(file);
  }, [ identities, existingIdentities ]);

  const handleDrag = useCallback((e:DragEvent) => {
    e.preventDefault();
    if (!e.isTrusted) {
      return;
    }

    if(e.type === 'dragleave') {
      setDragOver(false);
    }
    
    if (!dragOver && (e.type === 'dragenter' || e.type === 'dragover')) {
      setDragOver(true);
    }
  }, [ dragOver, location ]);

  const handleDrop = useCallback((e:DragEvent) => {
    e.preventDefault();

    if (!e.isTrusted) {
      return;
    }

    const files = e.dataTransfer?.files;
    if (files) {
      Array.from(files).forEach(processFile);
    }

    if (!location.pathname.includes('/identities/import')) {
      navigate('/identities/import');
    }

    setDragOver(false);
  }, [ location, navigate, processFile ]);

  useEffect(() => {
    window.addEventListener('dragenter', handleDrag)
    window.addEventListener('dragover', handleDrag)
    window.addEventListener('dragleave', handleDrag);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter',handleDrag)
      window.removeEventListener('dragover',handleDrag)
      window.removeEventListener('dragleave',handleDrag);
      window.removeEventListener('drop',handleDrop);
    }
  }, [ handleDrag, handleDrop]);

  return  <DragOverIdentitiesContext.Provider
    value={{
      identities,
      setIdentities,
      processFile,
    }}
  >
    {<Dialog open={dragOver}>
      <Box sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'left',
        p: 5,
      }}>
        <Typography variant={"h4"} sx={{ mb: 2 }} >
          Drop your identity files here.
        </Typography>
      </Box>
    </Dialog>}
    {children}
  </DragOverIdentitiesContext.Provider>
};