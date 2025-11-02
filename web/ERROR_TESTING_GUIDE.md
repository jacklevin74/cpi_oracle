# Error Testing Guide for TypeScript Migration

This document describes how to test for errors in the TypeScript migration at multiple levels.

## Quick Test Commands

```bash
# 1. TypeScript compilation errors
npm run typecheck

# 2. Build errors
npm run build

# 3. Run comprehensive test script
bash test-errors.sh

# 4. Manual API tests
curl http://localhost:3434/api/ts/current-price | jq
curl http://localhost:3434/api/ts/market-data | jq
curl http://localhost:3434/api/ts/volume | jq

# 5. Manual SSE stream test
timeout 3 curl -N http://localhost:3434/api/ts/price-stream

# 6. Check server logs
tail -50 /tmp/web_server.log | grep -i error
```

## Error Testing Levels

### Level 1: Compile-Time Errors (TypeScript)

**What it tests**: Type safety, syntax errors, missing imports, type mismatches

**Command**:
```bash
npm run typecheck
```

**Expected output**: No output (clean compilation)

**Example errors**:
```
src/database/price-history.repository.ts:45:12 - error TS2322: Type 'string' is not assignable to type 'number'.
src/api/api.controller.ts:12:5 - error TS2304: Cannot find name 'DatabaseServce'.
```

**How to fix**:
- Check the file and line number
- Fix type errors (add proper types, fix typos)
- Ensure all imports are correct
- Run `npm run typecheck` again

### Level 2: Build Errors (JavaScript Generation)

**What it tests**: TypeScript compilation to JavaScript, module resolution

**Command**:
```bash
npm run build
```

**Expected output**: No errors, files created in `dist/`

**Example errors**:
```
error TS6059: File '/path/to/file.ts' is not under 'rootDir'
error TS5055: Cannot write file 'dist/index.js' because it would overwrite input file
```

**How to fix**:
- Check `tsconfig.json` configuration
- Ensure `rootDir` and `outDir` are set correctly
- Run `npm run clean` then `npm run build`

### Level 3: Runtime Errors (Server Startup)

**What it tests**: Module loading, initialization errors, dependency issues

**Command**:
```bash
# Start server and check logs
node server.js > /tmp/web_server.log 2>&1 &
sleep 2
tail -20 /tmp/web_server.log
```

**Expected output**: Server starts without errors

**Example errors**:
```
Error: Cannot find module './dist/database'
TypeError: tsStreamService.addPriceClient is not a function
Error: ENOENT: no such file or directory, open 'price_history.db'
```

**How to fix**:
- Ensure `npm run build` was run
- Check that `dist/` directory exists
- Verify all TypeScript modules are compiled
- Check file paths and database locations

### Level 4: API Endpoint Errors (HTTP Responses)

**What it tests**: API logic, error handling, data fetching

**Commands**:
```bash
# Test each endpoint
curl -s http://localhost:3434/api/ts/current-price | jq -e '.error'
curl -s http://localhost:3434/api/ts/market-data | jq -e '.error'
curl -s http://localhost:3434/api/ts/volume | jq -e '.error'
curl -s http://localhost:3434/api/ts/settlement-history | jq -e '.error'
curl -s http://localhost:3434/api/ts/recent-cycles | jq -e '.error'
```

**Expected output**: `null` (no error field) or "No error - endpoint OK"

**Example errors**:
```json
{"error": "Failed to fetch oracle price"}
{"error": "Database not available"}
{"error": "Invalid parameters"}
```

**How to check**:
```bash
# See full response
curl -s http://localhost:3434/api/ts/current-price | jq

# Check for successful response
curl -s http://localhost:3434/api/ts/current-price | jq -e '.price' && echo "OK"
```

**How to fix**:
- Check server logs: `tail -50 /tmp/web_server.log`
- Verify RPC connection (if oracle/market errors)
- Check database exists: `ls -la price_history.db`
- Test Solana connection: `curl https://xolana.xen.network`

### Level 5: SSE Stream Errors (Real-time Updates)

**What it tests**: Server-Sent Events, WebSocket connections, streaming

**Commands**:
```bash
# Test each stream (auto-disconnects after 3 seconds)
timeout 3 curl -N http://localhost:3434/api/ts/price-stream
timeout 3 curl -N http://localhost:3434/api/ts/market-stream
timeout 3 curl -N http://localhost:3434/api/ts/volume-stream
timeout 3 curl -N http://localhost:3434/api/ts/status-stream
```

**Expected output**: `data: {...}` JSON messages every 1-2 seconds

**Example**:
```
data: {"price":110454.26,"age":0,"timestamp":1762060756931}

data: {"price":110455.12,"age":0,"timestamp":1762060757825}
```

**Example errors**:
- No output (stream not starting)
- HTTP 500 error
- Connection refused
- Malformed data (not starting with `data:`)

**How to fix**:
- Check StreamService is initialized in server.js
- Verify `tsStreamService.addPriceClient` exists
- Check Oracle/Market services are working
- Review server logs for SSE-related errors

### Level 6: Database Errors (Data Persistence)

**What it tests**: Database operations, SQL queries, data integrity

**Test via API**:
```bash
# Price history
curl -s http://localhost:3434/api/ts/current-price | jq '.price'

# Volume tracking
curl -s http://localhost:3434/api/ts/volume | jq '.cycleId'

# Settlement history
curl -s http://localhost:3434/api/ts/settlement-history | jq '.history | length'
```

**Test via SQLite**:
```bash
# Check database exists and has data
sqlite3 price_history.db "SELECT COUNT(*) FROM price_history;"
sqlite3 price_history.db "SELECT COUNT(*) FROM volume_history;"
sqlite3 price_history.db "SELECT COUNT(*) FROM settlement_history;"
```

**Example errors**:
```
Error: SQLITE_CANTOPEN: unable to open database file
Error: no such table: price_history
Error: UNIQUE constraint failed
```

**How to fix**:
- Check database file exists: `ls -la price_history.db`
- Verify schema: `sqlite3 price_history.db ".schema"`
- Check permissions: `chmod 664 price_history.db`
- Reinitialize: DatabaseService creates tables automatically

## Common Error Patterns

### 1. "Cannot find module" Error
```
Error: Cannot find module './dist/database'
```
**Fix**: Run `npm run build` to compile TypeScript

### 2. "is not a function" Error
```
TypeError: tsStreamService.addPriceClient is not a function
```
**Fix**:
- Check StreamService is exported correctly
- Verify compilation: `ls -la dist/services/stream.service.js`
- Rebuild: `npm run build`

### 3. RPC Connection Errors
```
Error: Failed to fetch oracle price: request failed
```
**Fix**:
- Test RPC: `curl https://xolana.xen.network`
- Check RPC_URL environment variable
- Try alternative RPC endpoint

### 4. Database Lock Errors
```
Error: SQLITE_BUSY: database is locked
```
**Fix**:
- Only one process should write to DB at a time
- Close other connections
- Restart server

### 5. Type Errors After Changes
```
error TS2322: Type 'string' is not assignable to type 'number'
```
**Fix**:
- Review the type definition
- Update code to match expected type
- Use type assertions if needed: `as number`

## Comprehensive Test Checklist

Use this checklist after making changes:

- [ ] **Compilation**: `npm run typecheck` passes
- [ ] **Build**: `npm run build` successful
- [ ] **Server starts**: No errors in logs
- [ ] **API endpoints**: All return valid JSON (no .error field)
- [ ] **SSE streams**: All streams emit data
- [ ] **Database**: Queries return data
- [ ] **Browser test**: proto2.html loads without console errors
- [ ] **Integration**: index.html still works (JavaScript API)

## Automated Testing

Run the full test suite:
```bash
bash test-errors.sh
```

This script tests all levels automatically and provides a summary report.

## Debugging Tips

1. **Always check server logs first**:
   ```bash
   tail -50 /tmp/web_server.log
   ```

2. **Test incrementally**: After each code change:
   ```bash
   npm run typecheck && npm run build
   ```

3. **Use verbose logging**: Enable logging in TypeScript services:
   ```typescript
   const tsStreamService = new StreamService({
     // ...
     enableLogging: true  // Enable debug output
   });
   ```

4. **Check dist/ output**: Verify JavaScript was generated:
   ```bash
   ls -la dist/
   ls -la dist/database/
   ls -la dist/services/
   ```

5. **Browser console**: Open DevTools in Chrome/Firefox:
   - Check Console for JavaScript errors
   - Check Network tab for failed API calls
   - Check EventSource connections for SSE

6. **Compare endpoints**: Test both JavaScript and TypeScript APIs:
   ```bash
   # JavaScript API (old)
   curl http://localhost:3434/api/current-price

   # TypeScript API (new)
   curl http://localhost:3434/api/ts/current-price
   ```

## Success Criteria

The TypeScript migration is error-free when:

1. **No TypeScript compiler errors**: `npm run typecheck` succeeds
2. **Clean build**: `npm run build` completes without errors
3. **Server runs**: No startup errors in logs
4. **All API endpoints respond**: No `.error` fields in responses
5. **All SSE streams work**: Data flows every 1-2 seconds
6. **Database operations succeed**: Queries return expected data
7. **Frontend works**: Both index.html and proto2.html functional
8. **No console errors**: Browser DevTools shows no errors

---

**Last Updated**: 2025-11-02
**TypeScript Migration Status**: Phase 1-5 Complete ✅
**Test Coverage**: Compile-time, Runtime, API, SSE, Database
