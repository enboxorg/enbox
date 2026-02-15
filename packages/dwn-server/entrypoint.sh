#!/bin/bash

# We're already in the correct directory (/app/packages/dwn-server)
exec bun dist/esm/src/main.js
