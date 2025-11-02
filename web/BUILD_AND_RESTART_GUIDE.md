# When to Build and Restart server.js

## Quick Answer

**YES, you need to build when**:
- You modify ANY `.ts` file in `src/`
- server.js loads modules from `dist/` (compiled TypeScript)
- Changes to TypeScript won't apply until compiled

**NO, you don't need to build when**:
- You modify `server.js` itself (it's JavaScript)
- You modify `public/app.js` (frontend JavaScript)
- You modify HTML/CSS files

## The Build → Restart Workflow

```bash
# 1. Edit TypeScript files
vim src/database/price-history.repository.ts

# 2. Build (compile TypeScript to JavaScript)
npm run build

# 3. Restart server to load new compiled code
lsof -ti :3434 | xargs kill -9 2>/dev/null
sleep 2
node server.js > /tmp/web_server.log 2>&1 &

# 4. Verify it worked
tail -20 /tmp/web_server.log
curl http://localhost:3434/api/ts/current-price | jq
```

## Why You Need to Build

server.js loads TypeScript code from the `dist/` directory:

```javascript
// server.js line 150-151
const { ApiController, StreamService } = require('./dist/api');
//                                                  ^^^^^ compiled!
const { VolumeRepository } = require('./dist/database');
//                                    ^^^^^ compiled!
```

**The Flow**:
```
src/database/volume.repository.ts  (TypeScript source)
           ↓
   npm run build (compile)
           ↓
dist/database/volume.repository.js  (JavaScript - what server.js loads)
           ↓
server.js requires and runs
```

## When Build is Required

### Scenario 1: Modify TypeScript Service

```bash
# Edit a TypeScript file
vim src/solana/oracle.service.ts

# ❌ WRONG: Restart without building
node server.js  # Still uses OLD compiled code in dist/

# ✅ CORRECT: Build then restart
npm run build && node server.js  # Uses NEW compiled code
```

### Scenario 2: Add New TypeScript File

```bash
# Create new TypeScript module
vim src/services/new-service.ts

# Build to generate dist/services/new-service.js
npm run build

# Now server.js can require('./dist/services/new-service')
```

### Scenario 3: Fix TypeScript Compilation Error

```bash
# You have a type error
npm run build
# Error: Property 'foo' does not exist on type 'Bar'

# Fix the error
vim src/api/api.controller.ts

# Rebuild
npm run build  # Must succeed before server can use it
```

## When Build is NOT Required

### Scenario 1: Modify server.js

```bash
# Edit JavaScript server file
vim server.js

# Just restart (no build needed - it's already JavaScript)
pkill -f "node server.js"
node server.js &
```

### Scenario 2: Modify Frontend

```bash
# Edit frontend JavaScript
vim public/app.js

# Just refresh browser (no server restart needed)
# server.js serves it as static file
```

### Scenario 3: Modify HTML/CSS

```bash
# Edit static files
vim public/index.html
vim public/styles.css

# Just refresh browser (no build, no restart needed)
```

## Quick Commands

### Full Build + Restart

```bash
# One-liner to build, restart, and check logs
npm run build && lsof -ti :3434 | xargs kill -9 2>/dev/null; sleep 2 && node server.js > /tmp/web_server.log 2>&1 & sleep 3 && tail -20 /tmp/web_server.log
```

### Check if Build is Needed

```bash
# Compare source vs compiled timestamps
stat -c '%Y %n' src/database/volume.repository.ts
stat -c '%Y %n' dist/database/volume.repository.js

# If source is newer, build is needed
```

### Auto-rebuild on Changes (Development)

```bash
# Terminal 1: Watch and rebuild on changes
npm run build:watch

# Terminal 2: Run server
node server.js
```

## Understanding the `dist/` Directory

```bash
# Show compiled output
ls -la dist/

# Structure mirrors src/
dist/
├── api/
│   ├── api.controller.js          # Compiled from src/api/api.controller.ts
│   ├── api.controller.d.ts        # Type definitions
│   └── api.controller.js.map      # Source maps
├── database/
│   ├── volume.repository.js       # Compiled from src/database/volume.repository.ts
│   ├── volume.repository.d.ts
│   └── volume.repository.js.map
├── solana/
├── services/
└── types/
```

**Key Points**:
- `.js` files = What server.js actually runs
- `.d.ts` files = Type definitions for TypeScript
- `.js.map` files = Debug source maps

## Common Mistakes

### Mistake 1: Forgetting to Build

```bash
# ❌ Edit TypeScript, restart without building
vim src/api/api.controller.ts
pkill -f "node server.js"
node server.js  # Still uses old dist/api/api.controller.js
```

**Fix**: Always build after editing TypeScript
```bash
npm run build && node server.js
```

### Mistake 2: Building Without Restarting

```bash
# ❌ Build but don't restart
npm run build
# server.js still has OLD code in memory
```

**Fix**: Restart after building
```bash
npm run build
pkill -f "node server.js"
node server.js
```

### Mistake 3: Checking Wrong File

```bash
# ❌ Edit source, then check source for changes
vim src/database/volume.repository.ts
cat src/database/volume.repository.ts  # This shows your changes

# But server.js loads from dist/!
cat dist/database/volume.repository.js  # This is what actually runs
```

**Fix**: Always build and check dist/

## Debugging Build Issues

### Issue 1: Build Fails

```bash
npm run build
# Error: Cannot find module 'xyz'

# Check for:
# 1. Missing imports
# 2. Typos in file paths
# 3. Missing npm packages
```

### Issue 2: Server Won't Load Compiled Code

```bash
node server.js
# Error: Cannot find module './dist/api'

# Check:
ls -la dist/api/  # Does it exist?
npm run build     # Did build succeed?
cat dist/api/index.js  # Is it a valid JS file?
```

### Issue 3: Changes Not Appearing

```bash
# Edit TypeScript
vim src/api/api.controller.ts

# Build
npm run build

# Restart
pkill -f "node server.js"
node server.js

# Still not working?
# 1. Check build actually succeeded
npm run build 2>&1 | grep -i error

# 2. Verify dist/ was updated
ls -lt dist/api/ | head -5

# 3. Clear node module cache
rm -rf node_modules/.cache
npm run build
```

## Production Deployment Workflow

```bash
# 1. Pull latest code
git pull

# 2. Install dependencies (if package.json changed)
npm install

# 3. Build TypeScript
npm run build

# 4. Verify build succeeded
npm run typecheck

# 5. Restart server
systemctl restart web-server
# OR
pm2 restart server

# 6. Verify server is running
curl http://localhost:3434/api/ts/current-price
```

## Development Workflow

```bash
# Option 1: Manual (full control)
# Edit → Build → Restart → Test
vim src/api/api.controller.ts
npm run build && node server.js &
curl http://localhost:3434/api/ts/current-price

# Option 2: Auto-rebuild (faster iteration)
# Terminal 1
npm run build:watch  # Auto-rebuilds on changes

# Terminal 2
nodemon server.js    # Auto-restarts on changes
```

## Summary: Decision Tree

```
Did you edit a .ts file in src/?
  ├─ YES → npm run build (required)
  │         └─ Then restart server
  └─ NO → Did you edit server.js?
            ├─ YES → Just restart server (no build)
            └─ NO → Did you edit public/*.js or *.html?
                      └─ YES → Just refresh browser (nothing needed)
```

---

**Golden Rule**: If you touch `src/`, you must `npm run build`
