#!/bin/bash

# We're already in the correct directory (/app/packages/dwn-server)
exec node dist/esm/src/main.js
