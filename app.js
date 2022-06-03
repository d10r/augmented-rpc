/*
 * Middleware for RPC requests which logs requests and answer, may do more in the future.
 * Usage: RPC=<http-url|ws-url> [PORT=<port>] <exe> 
 * 
 * If an http url is given, an http server is started.
 * If a websocket url is given, a websocket server is started.
 * 
 * The following additional functionality is implemented for http upstreams:
 * 
 * Responses are cached. For requests with unchanging response data (e.g. eth_chainId), it always serves the cached response.  
 * For some request (e.g. eth_blockNumber), it serves cached responses only for a given time in order to avoid rate limiting.
 * Can be set with env var CACHE_MAX_AGE (seconds).
 * 
 * If further tries to detect duplicate requests and slows them down in order to increase the chance of a cache hit.
 * That is, if the same request is received multiple times in short succession, all but the first one are briefly delayed.
 * 
 * Together this can greatly reduce the requests forwarded to upstream, increasing the chances of not running into rate limits.
 * 
 * If an upstream error occurs anyway, it will retry several times with exponential backoff. Only if the failure is permanent will the error propagate to the client.
 *
 * When the process ends, a brief summary of cached vs forwarded requests is printed.
 */

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");

if (!process.env.RPC) {
    throw Error("env var RPC not set");
}

const port = process.env.PORT || 3000;
const rpc = process.env.RPC;

let app; // http
let client; // ws
let server; // ws
let socket; // socket.io

(async () => {
    console.log("init");
    const rpcUrl = new URL(rpc);
    if(rpcUrl.protocol === "ws:" || rpcUrl.protocol === "wss:") {
        handleWsConnection(rpcUrl);
    } else {
        handleHttpConnection(rpcUrl);
    }
})()

// value type: { ts, val, readCnt, writeCnt } where `ts` is a timestamp (int) and val the cached value (whatever was returned)
const cache = new Map();

// print some stats on shutdown (e.g. Ctrl-C)
process.on("SIGINT", printStats);

function printStats() {
    console.log("stats:");
    console.log(`nr http requests processed: ${httpReqCnt}`);
    console.log(`nr http upstream responses: ${httpUpstreamResCnt}`);
    console.log(`nr http cached responses: ${httpCacheResCnt}`);
    
    console.log("cache stats:");
    for (const key of cache.keys()) {
        value = cache.get(key);
        console.log(`key ${key}: ${value.readCnt} reads, ${value.writeCnt} writes`);
    }
    process.exit();
}

function getCacheKey(req) {
    return `${req.body.method}${JSON.stringify(req.body.params)}`;
}

// returns the response to send from cache or undefined if not cached.
// Reasons for undefined response: unsupported method, not yet set, outdated
// param key: cache key
// param maxAgeMs: maximum age the cached entry may have to be considered. Can be `Infinity`
// param reqId: json-rpc id. Is just passed through
function getResponseFromCache(key, maxAgeMs, reqId) {
    if (cache.has(key)) {
        if (Date.now() - cache.get(key).ts <= maxAgeMs) {
            cacheRes = {
                jsonrpc: "2.0",
                id: reqId,
                result: cache.get(key).val
            }
            cache.set(key, { ...cache.get(key), readCnt: cache.get(key).readCnt+1 });
            return cacheRes;
        } else {
            console.debug(`cached entry skipped, too old (> ${maxAgeMs} ms)`);
        }
    }
    return undefined;
}

function writeResponseToCache(key, val) {
    const newValue = {
        val,
        ts: Date.now(),
        readCnt: cache.has(key) ? cache.get(key).readCnt : 0,
        writeCnt: cache.has(key) ? cache.get(key).writeCnt+1 : 1
    };
    console.debug(`writing to cache: key ${key}, value ${JSON.stringify(newValue)}`);
    cache.set(key, newValue);
}

// ********************************************************
// HTTP
// ********************************************************

let httpReqCnt = 0;
let httpUpstreamResCnt = 0;
let httpCacheResCnt = 0;
// key: method+params, value: timestamp
const duplicateDetector = new Map();
const DUPLICATE_DELAY_TRIGGER_THRESHOLD_MS=1000;
const DUPLICATE_MIN_DELAY_MS=500;
const DUPLICATE_RANDOM_MAX_EXTRA_DELAY_MS=1000;
const CACHE_MAX_AGE = process.env.CACHE_MAX_AGE || 10;
async function handleHttpConnection(rpcUrl) {
    app = express();
    app.use(bodyParser.json());

    app.listen(port, () => {
        console.log(`listening on port ${port}`);
    });
    
    app.get("/printstats", printStats);
    
    app.post("/", async (req, res) => {
        console.log(`RPC request at ${Date.now()/1000}: ${JSON.stringify(req.body)}`);
        //const data = {"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1};
        
        // check if duplicate - throttle if so in order to give the cache a chance to already be filled
        const cacheKey = getCacheKey(req);
        if (duplicateDetector.has(cacheKey)) {
            const prevCallTs = duplicateDetector.get(cacheKey);
            if (Date.now() - prevCallTs < DUPLICATE_DELAY_TRIGGER_THRESHOLD_MS) {
                // adding randomization to the delay in order to avoid scenarios where all duplicates meet a barely outdated cache
                const delayMs = DUPLICATE_MIN_DELAY_MS + Math.floor(Math.random() * DUPLICATE_RANDOM_MAX_EXTRA_DELAY_MS);
                console.debug(`delaying potential duplicate request for ${delayMs} ms...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }
        duplicateDetector.set(cacheKey, Date.now());
        
        // Check if we can reuse a cached response
        const cacheMaxAgeMs = ["eth_chainId", "net_version"].includes(req.body.method) ? Infinity : CACHE_MAX_AGE*1000;
        const cachedResponse = getResponseFromCache(cacheKey, cacheMaxAgeMs, req.body.id);
        if (cachedResponse) {
            console.log(`RPC cached response: ${JSON.stringify(cachedResponse)}`);
            res.send(cachedResponse);
            httpCacheResCnt++;
        } else {
            // ... forward request to upstream
            try {
                const rpcRes = await upstreamHttpRequest(rpc, req.body);
                console.log(`RPC response: ${JSON.stringify(rpcRes.data)}`);
                httpUpstreamResCnt++;
                
                // send response to the client
                res.send(rpcRes.data);
                
                // cache some of them
                if (["eth_chainId", "eth_blockNumber", "net_version", "eth_getTransactionReceipt"].includes(req.body.method)) {
                    writeResponseToCache(cacheKey, rpcRes.data.result);
                }
            } catch(err) {
                console.error(`upstream request permanently failed: ${err}`);
                res.status(500).send(err);
            }
        }
        httpReqCnt++;
    });
}

// param rpc: url of the upstream http rpc
// param reqBody: body of the POST request
// returns the response data
// throws on permanent failure (after exhausting all retries)
// if the request fails, it retries with exponential backoff
async function upstreamHttpRequest(rpc, reqBody, nrRetries = 10, initialTimeoutMs = 2000) {
    try {
        return await axios.post(rpc, reqBody);
    } catch(err) {
        console.debug(`upstream retry - #${nrRetries} attempts left, next timeout: ${initialTimeoutMs} ms`);
        let forwardedErr = "unspecified";
        if(err.response) {
            console.error(`upstream err | response: ${JSON.stringify(err.response)}`);
            forwardedErr = JSON.stringify(err.response);
        } else if(err.request) {
            console.error("upstream err | no response´");
            forwardedErr = JSON.stringify(err.request.data);
        } else {
            console.error("upstream err | no response, no request -> WTF´");
        }
        
        // retry loop implemented via recursion. Double timeout for exponential backoff
        if (nrRetries > 0) {
            await new Promise(resolve => setTimeout(resolve, initialTimeoutMs));
            return upstreamHttpRequest(rpc, reqBody, nrRetries-1, initialTimeoutMs*2)
        } else {
            throw Error(forwardErr) // if giving up, hand over the last error
        }
    }
}

// ********************************************************
// Websocket 
// ********************************************************

function handleWsConnection(rpcUrl) {
    console.log("opening websocket connection...");

    const WS = require("ws");
    server = new WS.WebSocketServer({port: port});
    client = new WS(rpc);
    
    let connCnt = 0;
    
    server.on("connection", conn => {
        const connId = connCnt++;
        console.log(`WS #${connId} client connection established`);
        conn.on("message", data => {
            console.log(`WS #${connId} forwarding: ${data.toString()}`);
            client.send(data.toString(), (err) => {
                if(err !== undefined) {
                    console.log(`### WS #${connId} send error: ${err}`);
                }
            });
        });
        
        client.on("message", msg => {
            console.log(`WS #${connId} backwarding: ${msg.toString()}`);
            conn.send(msg.toString());
        });
    });
    
    server.on("close", () => console.log("### A connection was closed"));
    server.on("error", (err) => console.log(`### Error ${err}`));
    
    client.once("open", () => console.log("WS upstream connected!"));
}

/*
app.post("/ws", (req, res) => {
    console.log(`req id ${req.body.id}, body: ${JSON.stringify(req.body, null, 2)}`);
    //const data = {"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1};
    client.send(JSON.stringify(req.body), res => console.log("Send response: ", res));
});
*/


/*
app.post("/io", (req, res) => {
    console.log(`req.body: ${JSON.stringify(req.body, null, 2)}`);
    //const data = {"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1};
    socket.emit(JSON.stringify(req.body), res => console.log("RPC response: ", res));
});
*/
