import { Box, CircularProgress, Container, Typography } from "@mui/material"

const Loader:React.FC<{ message: string }> = ({ message }) => {
  return <Container maxWidth="sm">
    <Box display="flex" flexDirection="column" alignItems="center" justifyContent="center" minHeight="100vh">
      <CircularProgress size={48} color="primary" />
      <Typography variant="h6" mt={2}>
        {message}
      </Typography>
    </Box>
  </Container>
}

export default Loader;