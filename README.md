# About

This is a simple nodejs app which can be used to _augment_ Ethereum RPC requests.
It logs requests and responses in full detail, which can help with debugging.
It also applies a few simple caching strategies. More details below.

To use it, first install dependencies with `npm i`, then run with:
```
RPC=<http-url|ws-url> [PORT=<port>] node app.js
```
 
If an http url is given, an http server is started.
If a websocket url is given, a websocket server is started.
 
The following additional functionality is implemented for http upstreams:
* Responses are cached. For requests with immutable response (e.g. eth_chainId), it always serves the cached response.  
* For some request (e.g. eth_blockNumber), it serves cached responses only for a given time in order to avoid rate limiting. Can be set with env var CACHE_MAX_AGE (seconds).
* Tries to detect duplicate requests and slows them down in order to increase the chance of a cache hit. That is, if the same request is received multiple times in short succession, all but the first one are briefly delayed.
 
Together this can greatly reduce the requests forwarded to upstream, increasing the chances of not running into rate limits.
This was created for a very chatty deploy script, allowing to use it with public RPCs with severe rate limiting policy.
 
If an upstream error occurs anyway, it will retry several times with exponential backoff. Only if the failure is permanent will the error propagate to the client.
When the process ends (ctrl-c), a brief summary of cached and forwarded requests is printed.
