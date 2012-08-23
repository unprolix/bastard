[![build status](https://secure.travis-ci.org/unprolix/bastard.png)](http://travis-ci.org/unprolix/bastard)
BASTARD
=======

The purpose of bastard is to serve static content over the web quickly, according to best practices, in a way that is easy to set up, run, and administer. It is implemented as a module intended to be run from within node.js. It may be invoked as part of another server process, serving only URLs with a given set of prefixes, or it may be the entire server all on its own. It will automatically minify and compress data, cache the data on disk, and verify the validity of its cached data on startup. While running, it keeps cached data in memory and does not expire data from the cache. Restarts should be relatively quick and easy because minified/compressed data will be read from the disk cache on the first request for that item.

Additionally, bastard will automatically generate cryptographic fingerprints for all files it serves, and return this fingerprint as the value of the Etag header in its responses. Files are available at fingerprinted URLs so that they can be cached indefinitely by client browsers. You can programmatically ask it for the current fingerprinted URL for a file so that you can use that URL in HTML you generate external to the server. When bastard serves fingerprinted files, they are served with very long cache times because those URLs should always serve the same content.

CSS, Javascript, and HTML are minified, including CSS and Javascript inside HTML files. Files of other types are not modified, though they will be compressed for transmission if they're not image files. (Image files are never compressed by this software.) Note that in some rare cases, HTML minification can cause problems. In bastard, the HTML minification is not extremely aggressive and so will probably be fine. You can turn it off with a future config option if you are worried or actually find a problem in practice.


Installing
==========

        npm install bastard


Running Standalone
==================

Configure the settings via npm. There are reasonable defaults but you definitely need to specify the base directory where your files are:

        npm config bastard:base /path/with/good/intentions
        npm start bastard

If you are running the standalone server and want to programmatically find out the current fingerprint for a file, make a request for the file with an incorrect fingerprint such as "BASTARD". The server's response will contain the valid fingerprint, which you may then parse out and use in your own externally-generated HTML.


Running from your own code
==========================

1. Create the bastard object:

        var bastard = require ('bastard');
        var Bastard = bastard.Bastard;
        var bastardObj = new Bastard (config);

        // if you want to load every file into the cache before you get started:
        bastardObj.preload (callback);

2. Create your own HttpServer object and pass requests to it from within the associated handler:

        var handled = bastardObj.possiblyHandleRequest (request, response);

If the above function returns true, the request has been handled and you don't need to do anything else. Depending on how you want to structure your server, you can check bastard before or after your own URLs.


To find out the current fingerprint of a file
---------------------------------------------

        bastardObj.getFingerprint (filePath, basePath, function (err, fingerprint) {});

    * `filePath`: full path to the file
    * `basePath`: path to the file within the base directory (may be the same as the URL path for the file)
    * `callback`: if present, will be called with the first argument being any error (or null) and the second argument being the fingerprint

If callback is not present and the fingerprint is already known, it will be returned immediately as the result of the function call. If callback is not present and the fingerprint is not already known, the fingerprint will be internally calculated and null will be returned from the function call.

You only need to specify one of filePath and basePath.

For an example of how to run bastard from your own code, examine the file start.js in the bastard package.

To preload the entire base directory
------------------------------------


        bastardObj.preload (function (err) {});

Calling this function and waiting until the callback is invoked will ensure that all fingerprints have been precalculated before any user requests are seen. It does not load all files into memory, but does load all information about each file, and ensure that each file has been minified (where possible) and compressed (when appropriate).


Configuration
=============

The following configuration variables may be set with `npm config bastard:xxx yyy` where `xxx` is the name of the parameter and `yyy` is the desired value. More help on configuration variables may be obtained via `npm`. These variables also correspond to keys which may be present in single argument to the `Bastard` object's constructor. (In the constructor, however, the URL patterns all default to null--that is, not checked.)

Note that there are some not-too-complicated subtleties in URL matching.  The raw prefix, if defined, is checked first, followed by the fingerprint prefix (if defined), and then only the regular prefix (if defined)--and the first match is considered to be definitive. This means that with the default values provided in the standalone server, if you have a directory called "raw" in your base directory, those files will never be served except as raw or fingerprinted.


`base`    Directory where files to be served reside. (Default: empty)

`defaultFileName`	The name of the default file when a path ending in '/' is specified. (Default: /index.html/)

`rawURLPrefix`  The prefix for URLs from which raw files should be served. These will be just as they are on disk: not minified, not compressed. (Default: /raw/)

`fingerprintURLPrefix`  The prefix for URLs from which fingerprinted files should be served. The fingerprint will appear in the URLs after this prefix followed by the relative pathname to the file in the base directory. (Default: /f/)

`urlPrefix` The prefix for URLs from which non-fingerprinted files should be served. (Default: /)

`workingDir`  The location for temporary files to be kept. This includes on-disk copies of minified and compressed files that originate in the base directory. (Default: /tmp/bastard.dat)

`debug` If true, turns on some debugging functionality. (Default: false)

`directories` If true, will generate directory listings. (Not yet implemented.) (Default: false)

`pidFile` The file into which to write the PID of the server. (Default: /var/run/bastard.pid)

`virtualHostMode` If true, directories in `base` represent hostnames. Files will be served from the matching directory based on the HTTP 1.1 hostname received. If there is no match, the first compoent (e.g. "www." from "www.example.com") is removed and the match is tried again. If there is still no match, the default directory is used. (See below)

`defaultHost` The name of the directory to be used when the HTTP 1.1 hostname matches no other directory. Used only when `virtualHostMode` is true.

Standalone Server
-----------------

In addition, the following configuration parameters are used only by the standalone server and do not correspond to constructor arguments:

`host`	Hostname or IP address at which to listen. If empty, will bind to all available IP addresses. (Default: empty)

`port`	Port number at which to listen. (Default: 80)

`preload`	If true, a cache record will be created for each available file before the server begins. This will not load all data from disk, but will calculate all new fingerprints necessary.



Limitations
===========

If the mime type for a file begins with "image/", it will not be gzipped.  All other files will be gzipped if the client indicates that it can understand gzipped data. This may not be the best choice for all file types.


Project Status
==============

This is a project built by the author for his own use. Contributions are welcomed.

The public repository for the project is found at: https://github.com/unprolix/bastard

Future features:

* Ability to use an API, instead of the filesystem, as the source of files to be served. This would allow serving data from (e.g.) key/value stores.

* Ability to use an API to upload processed files from base directory to a key/value store--including fingerprinted URLs. This would allow bastard to front for a CDN.


License
=======

Copyright 2011, Jeremy Bornstein <jeremy@jeremy.org>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.

    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.

    * Neither the name of the project nor the names of its contributors may
      be used to endorse or promote products derived from this software
      without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL JEREMY BORNSTEIN BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.