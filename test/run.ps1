$ErrorActionPreference = "Stop"

npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run size
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm run build:pages
exit $LASTEXITCODE
