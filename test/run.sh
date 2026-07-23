#!/usr/bin/env bash
set -euo pipefail

npm run build
npm test
npm run size
npm run build:pages
