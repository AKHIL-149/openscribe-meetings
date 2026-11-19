// Installs a git pre-push hook that runs the private-data check.
import fs from 'fs';
fs.writeFileSync('.git/hooks/pre-push', '#!/bin/sh\nnode scripts/check-private.mjs\n', { mode: 0o755 });
console.log('pre-push hook installed');
