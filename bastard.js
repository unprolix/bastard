'use strict';

var events = require ('events');
var child_process = require ('child_process');
var fs = require ('fs');
var uglify = require ("uglify-js");
var csso = require ("csso");
var gzip = require ("gzip");
var mime = require ('mime');
var html_minifier = require ('html-minifier')

/*

	
TODO:
	optionally upload fingerprinted files to S3
	generate S3 URLs for files
	allow preloading of all files into memory

*/

// These are reusable
var JSP = uglify.parser;
var PRO = uglify.uglify;

function minifyJavascript (data, filePath) {
	try {
		var ast = JSP.parse (data); // parse code and get the initial AST
		ast = PRO.ast_mangle (ast); // get a new AST with mangled names
		ast = PRO.ast_squeeze (ast); // get an AST with compression optimizations
		return PRO.gen_code (ast); // compressed code here
	}
	catch (err) {
		// var keys = [];
		// for (var key in err) { keys.push (key); }
		// console.error ("Error keys: " + keys);
		// console.error (err.stack);
		// console.error (err.type);
		// console.error (err.message);
		// console.error (err.name);
		console.error ("Problem parsing/minifying Javascript for " + filePath + ": " + err.message);
		return "// Problem parsing Javascript -- see server logs\n" + data;
	}
}


function Bastard (config) {
	var me = this;
	var debug = config.debug;
	if (debug) console.info ("Debugging output enabled");
	if (debug) console.info (config);

	var defaultFileName = config.defaultFileName || 'index.html';
	var alwaysCheckModTime = config.alwaysCheckModTime;
	var baseDir = config.base;
	var errorHandler = config.errorHandler;
	var storageDir = config.workingDir || '/tmp/bastard.dat';
	var urlPrefix = config.urlPrefix;
	var rawURLPrefix = config.rawURLPrefix;
	var virtualHostMode = config.virtualHostMode || false;
	var fingerprintURLPrefix = config.fingerprintURLPrefix;
	if (baseDir.charAt (baseDir.length-1) != '/') baseDir += '/';
	
	me._emitter = new events.EventEmitter ();
	
	var virtualHostDirs;
	if (virtualHostMode) {
		virtualHostDirs = {};
		fs.readdir (baseDir, function (err, list) {
			if (err) throw "Problem reading virtual host directories from " + baseDir;
			for (var i = 0; i < list.length; i++) {
				var item = list[i];
				virtualHostDirs[item.toLowerCase ()] = baseDir + item + "/";
			}
		});	
	}
	
	me.minifyHTML = function (data, filePath, basePath) {
		if (debug) {
			console.info ("******** Minimizing HTML");
			console.info ("file path: " + filePath);
			console.info ("base path: " + basePath);
		}
		var baseDir = filePath.substring (0, filePath.length - basePath.length);
		if (debug) {
			console.info ("base dir: " + baseDir);
			console.info ("********");
		}

		var provisional = false; // set to true if we are missing a fingerprint
		
		// identify embedded CSS and replace it with minimized CSS
		// identify embedded JS and replace it with minimized JS
		// identify referenced CSS and if the fingerprint is available, replace with a reference to the fingerprinted version
		// identify referenced JS and if the fingerprint is available, replace with a reference to the fingerprinted version
		// identify referenced images and if the fingerprint is available, replace with a reference to the fingerprinted version
		
		var dirPath = basePath.substring (0, basePath.lastIndexOf('/'));
		
		var Scanner = require("htmlscanner").Scanner;
		var scanner = new Scanner (data);
		var processed = '';
		var insideScriptTag = false;
		var insideCSSTag = false;
		do {
			var token = scanner.next ();
			var tokenType = token[0];
			switch (tokenType) {
				case 1:
					var tagName = token[1];
					var attributes = {};
					for (var i = 2; i < token.length; i+= 2) {
						attributes[token[i]] = token[i+1];
					}
	
					var tagNameLC = tagName.toLowerCase ();
					if (tagNameLC == 'script') {
						insideScriptTag = true;
						if ('src' in attributes) {
							// special processing for script tags
							var src = attributes.src;
							var scriptPath;
							if (src.charAt(0) == '/') {
								scriptPath = baseDir + src.substring(1);
								if (debug) console.info ("Script source begins with slash so it's from base files dir of the bastard, and path is: " + scriptPath);
							} else {
								scriptPath = baseDir + dirPath + "/" + src;
								if (dirPath.length > 0) src = '/' + dirPath + "/" + src;
								else src = '/' + src;
								if (debug) console.info ("Script source does not begin with slash so it's relative to the requested url, and path is: " + scriptPath);								
							}
							
							var fingerprint = me.getFingerprint (scriptPath, null);
							if (!fingerprint) {
								if (debug) console.info ("No fingerprint found for " + scriptPath);
								provisional = true;
							} else {
								attributes.src = fingerprintURLPrefix + fingerprint + src;
							}
						}
					} else if (tagNameLC == 'link' && attributes.type == 'text/css' && 'href' in attributes) {
						if (debug) console.info ("*** PROCESSING CSS ***");
						// special processing for css files
						var src = attributes.href;
						var scriptPath;
						if (src.charAt(0) == '/') {
							scriptPath = baseDir + src.substring(1);
							if (debug) console.info ("Script source begins with slash so it's from base files dir of the bastard, and path is: " + scriptPath);
						} else {
							scriptPath = baseDir + dirPath + "/" + src;
							if (dirPath.length > 0) src = '/' + dirPath + "/" + src;
							else src = '/' + src;
							if (debug) console.info ("Script source does not begin with slash so it's relative to the requested url, and path is: " + scriptPath);								
						}
						
						var fingerprint = me.getFingerprint (scriptPath, null);
						if (!fingerprint) {
							if (debug) console.info ("No fingerprint found for " + scriptPath);
							provisional = true;
						} else {
							attributes.href = fingerprintURLPrefix + fingerprint + src;
						}
					} else if (tagNameLC == 'style' && attributes.type == 'text/css') {
						insideCSSTag = true;
					}
					
					var tag = "<" + tagName;
					for (var attr in attributes) tag += " " + attr + '="' + attributes[attr] + '"';
					tag += ">";
					processed += tag;
					break;
				case 2:
					var tagName = token[1];
					var tagNameLC = tagName.toLowerCase ();
					if (tagNameLC == 'script') {
						insideScriptTag = false;
					} else if (tagNameLC == 'style') {
						insideCSSTag = false;
					}
					processed += "</" + tagName + ">";
					break;
				case 4:
					if (insideScriptTag) {
						if (debug) console.info ("Minifying inline javascript: " + insideScriptTag);
						processed += minifyJavascript (token[1], null);
					} else if (insideCSSTag) {
						if (debug) console.info ("Minifying inline CSS: " + insideCSSTag);
						processed += csso.justDoIt (token[1]);
					} else {
						processed += token[1];
					}
					break;
			}
		} while (token[0]);
	
		var minified = html_minifier.minify (processed, {
			removeComments: true,
			removeCommentsFromCDATA: true,
			removeCDATASectionsFromCDATA: true,
			collapseWhitespace: false, /* we really want the "collapse into a single space" version of this */
			collapseBooleanAttributes: true,
			removeAttributeQuotes: true,
			removeRedundantAttributes: true,
			removeEmptyAttributes: true,
			removeOptionalTags: true,
			removeEmptyElements: false		
		});
		
		if (provisional) return {value: minified, provisional: true};
		else return minified;
	};
	
	setupStorageDir ();
	
	// console.info ("*** " + config.workingDir);
	// console.info ("*** " + storageDir);
	
	var CACHE_INFO_FILENAME = 'cache_info.json';
	var cacheData = {};
	if (errorHandler && !(errorHandler instanceof Function)) errorHandler = null;

	var preprocessors = {
		'.js': minifyJavascript,
		'.css': csso.justDoIt,
		'.html': me.minifyHTML
	};

	var ONE_WEEK = 60 * 60 * 24 * 7;
	var ONE_YEAR = 60 * 60 * 24 * 365;

	function formatCacheRecord (cacheRecord) {
		var keys = [];
		for (var key in cacheRecord) keys.push (key);
		keys.sort ();
		var result = [];
		for (var i = 0; i < keys.length; i++) {
			var key = keys[i];
			var value = cacheRecord[key];
			if (key == 'gzip') value = "BINARY DATA";
			var valueType = typeof value;
			if (valueType == 'number') result.push (key + ': ' + value);
			if (value == null) result.push (key + ': null');
			else result.push (key + ': ' + value.toString ().substring(0,64));
		}
		return result.join ('; ');
	}


	function setupStorageDir () {
		function checkSetupComplete () {
			if (debug) console.info ("Setup complete?");
			if (me.ready) return;
			if (debug) console.info ("Checking processedFileCacheDir");
			if (!me.processedFileCacheDir) return;
			if (debug) console.info ("Checking gzippedFileCacheDir");
			if (!me.gzippedFileCacheDir) return;
			if (debug) console.info ("Checking loadingOldCache");
			if (me.loadingOldCache) return;
			if (debug) console.info ("Setup is complete");
			// console.info (cacheData);
			me._emitter.emit ('ready');
			me.ready = true;
		}
		
		fs.stat (storageDir, function (err, statobj) {
			if (err) {
				if (err.code == 'ENOENT') {
					//console.info ("Storage dir does not exist yet.");
					// does not exist. can we make it?
					fs.mkdir (storageDir, 448 /* octal: 0700 */, function (exception) {
						if (exception) throw exception;
						//console.info ("Created storage directory for processed file cache");
						finishStorageDirSetup ();
					});
				} else {
					throw 'Problem with working directory: ' + err.message;
				}
			} else {
				if (!statobj.isDirectory ()) {
					throw "Storage directory is something I can't work with.";
				} else {
					// it is a directory already.
					finishStorageDirSetup ();
				}
			}
		});

		function setupProcessedFileCacheDir () {
			var processedFileCacheDir = me.storageDir + 'processed';
			fs.stat (processedFileCacheDir, function (err, statobj) {
				if (err) {
					if (err.code == 'ENOENT') {
						//console.info ("Processed file cache dir does not exist yet.");
						// does not exist. can we make it?
						fs.mkdir (processedFileCacheDir, 448 /* octal: 0700 */, function (exception) {
							if (exception) throw exception;
							//console.info ("Created directory for processed files");
							finishSetup ();
						});
					} else {
						throw 'Problem with processed file cache directory: ' + err.message;
					}
				} else {
					if (!statobj.isDirectory ()) {
						throw "Processed file cache directory is something I can't work with.";
					} else {
						// it is a directory already.
						finishSetup ();
					}
				}
			});

			function finishSetup () {
				processedFileCacheDir = fs.realpathSync (processedFileCacheDir);
				if (processedFileCacheDir.charAt (processedFileCacheDir.length-1) != '/') processedFileCacheDir += '/';
				me.processedFileCacheDir = processedFileCacheDir;
				// console.info ("Using directory for cached processed files: " + processedFileCacheDir);
				checkSetupComplete ();
			}
		}

		function setupGzippedFileCacheDir () {
			var gzippedFileCacheDir = me.storageDir + 'gzipped';
			fs.stat (gzippedFileCacheDir, function (err, statobj) {
				if (err) {
					if (err.code == 'ENOENT') {
						//console.info ("Gzipped file cache dir does not exist yet.");
						// does not exist. can we make it?
						fs.mkdir (gzippedFileCacheDir, 448 /* octal: 0700 */, function (exception) {
							if (exception) throw exception;
							//console.info ("Created directory for gzipped files");
							finishSetup ();
						});
					} else {
						throw 'Problem with gzipped file cache directory: ' + err.message;
					}
				} else {
					if (!statobj.isDirectory ()) {
						throw "Gzipped file cache directory is something I can't work with.";
					} else {
						// it is a directory already.
						finishSetup ();
					}
				}
			});

			function finishSetup () {
				gzippedFileCacheDir = fs.realpathSync (gzippedFileCacheDir);
				if (gzippedFileCacheDir.charAt (gzippedFileCacheDir.length-1) != '/') gzippedFileCacheDir += '/';
				me.gzippedFileCacheDir = gzippedFileCacheDir;
				// console.info ("Using directory for cached gzipped files: " + gzippedFileCacheDir);
				checkSetupComplete ();
			}
		}

	
		function loadOldCache (oldCache) {
			//we have filepath -> rawSize, fingerprint, modified
			if (debug) console.info ("Loading old cache");
			var remaining = 0;
			for (var filePath in oldCache) remaining++;
			if (debug) console.info ("Will check record count: " + remaining);
			function checkCacheRecord (path, record) {
				// compare size and modtime with the live ones from the file.
				// if those are the same, we assume the fingerprint and cached processed/compressed files are still good.
				// NOTE that this is vulnerable to sabotage or disk errors, etc.
				
				fs.stat (path, function (err, statObj) {
					if (err) {
						if (debug) console.warn ("Problem with file: " + path + ": " + err);
					} else {
						if (debug) {
							console.info ("* Rechecking file: " + path);
							console.info ("Stored size: " + record.rawSize);
							console.info ("  Live size: " + statObj.size);
						}
						if (record.rawSize == statObj.size) {
							var cacheWhen = Date.parse (record.modified);
							if (debug) console.info ("Stored mtime: " + cacheWhen);
							if (debug) console.info ("  Live mtime: " + statObj.mtime.getTime ());
							if (cacheWhen == statObj.mtime.getTime ()) {
								if (debug) console.info ("**** ELIGIBLE FOR REUSE");
								record.reloaded = true;
								cacheData[path] = record; // keep the info but load the data on demand only.
							} else {
								if (debug) console.info ("**** NOT ELIGIBLE FOR REUSE (different mod times)");
							}
						} else {
							if (debug) console.info ("**** NOT ELIGIBLE FOR REUSE (different sizes)");
						}
					}
					remaining--;
					if (debug) console.info ("Remaining cache records to check: " + remaining);
					if (remaining <= 0) {
						if (debug) console.info ("Checked all records.");
						delete me.loadingOldCache;
						checkSetupComplete ();
					}
				});
			}
		
			for (var filePath in oldCache) {
				if (filePath.indexOf (baseDir) != 0) continue; // not in our current purview
				var cacheRecord = oldCache[filePath];
				checkCacheRecord (filePath, cacheRecord);
			}
		}
	
	
		function finishStorageDirSetup () {
			storageDir = fs.realpathSync (storageDir);
			if (storageDir.charAt (storageDir.length-1) != '/') storageDir += '/';
			me.storageDir = storageDir;
			// console.info ("Using working directory: " + storageDir);
		
			me.cacheInfoFilePath = me.storageDir + CACHE_INFO_FILENAME;
			me.loadingOldCache = true;

			fs.readFile (me.cacheInfoFilePath, 'utf8', function (err, data) {
				if (err) {
					if (debug) console.warn ("Could not reload cache info: " + err);
					delete me.loadingOldCache;
					checkSetupComplete ();
					return;
				}
				try {
					var oldCache = JSON.parse (data);
					loadOldCache (oldCache);
				}
				catch (err) {
					console.warn ("Could not parse reloaded cache info");
					delete me.loadingOldCache;
					checkSetupComplete ();
				}
				
			});

			// console.info ("Setting up subdirs");
			setupProcessedFileCacheDir ();
			setupGzippedFileCacheDir ();
		}
	}


	function prepareCacheForFile (filePath, basePath, callback) {
		if (debug) console.info ("In prepareCacheForFile(" + filePath + ", " + basePath + ")");
		var cacheRecord = {};

		function writeCacheData (filePath, data) {
			// write data as cached data for the given filePath
			// if there is any problem here, just bail with an informational message. errors are not critical.
			
			var parts = filePath.split ('/');
			var curDir = '';
			var dirsToCheck = [];
			for (var i = 0; i < parts.length - 1; i++) { // NOTE that we are skipping the last element, which is the filename itself.
				curDir += '/' + parts[i];
				dirsToCheck.push (curDir);
			}
			dirsToCheck.reverse (); // put the top dir at the end, so we can pop.

			function checkNextDir () {
				if (dirsToCheck.length == 0) {
					doneMakingDirectories ();
					return;
				}
				
				var dir = dirsToCheck.pop ();
				fs.stat (dir, function (err, statObj) {
					if (err) {
						if (err.code != 'ENOENT') {
							console.warn ("Unexpected error investigating directory: " + dir);
						} else {
							// did not exist. this is fine; create it.
							fs.mkdir (dir, 448 /* octal: 0700 */, function (err) {
								if (err && err.code != 'EEXIST') { // an EEXIST means it was created in the meantime--acceptable
									console.info ("Problem creating " + dir + ": " + err);
								} else {
									checkNextDir ();
								}
							});
						}
					} else {
						if (!statObj.isDirectory ()) {
							console.warn ("Should be a directory: " + dir);
						} else {
							checkNextDir ();
						}
					}
				});
			}
			checkNextDir ();

			function doneMakingDirectories () {
				fs.writeFile (filePath, data, 'utf8', function (err) {
					if (err) {
						console.warn ("Could not write data into: " + basePath + ": " + err.message);
					}
				});
			}	
		}


		function prerequisitesComplete () {
			//console.info ('Setting cache for file ' + fileName);
			// TODO: do we want to NOT store the data if it was an error?
			cacheData[filePath] = cacheRecord; // set it all at once
			if (callback instanceof Function) callback (cacheRecord);
			if (cacheRecord.processedProvisional) {
				if (debug) console.info ("Erasing provisional data.");
				delete cacheRecord.remade;
				delete cacheRecord.processed;
				delete cacheRecord.gzip;
			}
		}

		var dataComplete = false; // we need to know this explicitly, in case there was an error
		var statComplete = false;
		var fingerprintComplete = false;
		var suffix = filePath.substring (filePath.lastIndexOf ('.'));
		var preprocessor = preprocessors[suffix];
		var mimeType = mime.lookup (suffix);
		var charset = mime.charsets.lookup (mimeType);
		if (!charset && mimeType == 'application/javascript') charset = 'utf-8';
		if (charset) {
			cacheRecord.contentType = mimeType + '; charset=' + charset;
			cacheRecord.charset = charset;
		} else {
			cacheRecord.contentType = mimeType;
		}

		child_process.execFile ('/usr/bin/env', ['openssl', 'dgst', '-sha256', filePath], function (err, stdout, stderr) {
			if (err) {
				if (err.message.indexOf ('No such file or directory') == -1) console.error ("Error from fingerprinting: " + JSON.stringify (err));
				cacheRecord.fingerprintError = err;
			} else {
				cacheRecord.fingerprint = stdout.substr (-65, 64);
				if (debug) console.info ("Fingerprint for " + filePath + ": " + cacheRecord.fingerprint);
			}
			fingerprintComplete = true;
			if (dataComplete && statComplete) prerequisitesComplete ();
		});

		if (debug) console.info ("Reading " + filePath + " with charset: " + charset + " for mime type: " + mimeType);
	    fs.readFile (filePath, charset, function (err, data) {
	        if (err) {
	            if (debug) console.log("Error from file " + filePath + ": " + err);
				cacheRecord.fileError = err;
				dataComplete = true;
				if (statComplete && fingerprintComplete) prerequisitesComplete ();
	        } else {
				if (rawURLPrefix) {
					if (debug) { console.info ("   ... keeping raw data of size " + data.length); }
					cacheRecord.raw = data; // only keep it if we might be asked for it later
				}
				
				if (!basePath) {
					basePath = filePath.substring (baseDir.length);
					if (virtualHostMode) basePath = basePath.substring (basePath.indexOf ('/') + 1);
				}
				
				// console.info ("Preprocessor: " + preprocessor);
				if (preprocessor) {
					var processed = preprocessor (data, filePath, basePath);
					if (processed.provisional) {
						if (debug) console.info ("Preprocessed data is provisional.");
						cacheRecord.processed = processed.value;
						cacheRecord.processedProvisional = true;
					} else {
						cacheRecord.processed = processed;
					}
				} else {
					// no preprocessor for this type.
					cacheRecord.processed = data;
				}
				writeCacheData (me.processedFileCacheDir + basePath, cacheRecord.processed);
				
				if (cacheRecord.contentType && cacheRecord.contentType.indexOf ('image/') != 0) {
					gzip (cacheRecord.processed, function (err, gzippedData) {
						if (err) {
							cacheRecord.fileError = err;
						} else {
							cacheRecord.gzip = gzippedData;
							writeCacheData (me.gzippedFileCacheDir + basePath + '.gz', cacheRecord.gzip);
						}
						dataComplete = true;
						if (statComplete && fingerprintComplete) prerequisitesComplete ();
					});					
				} else {
					console.info ("Not gzipping an image");
					dataComplete = true;
					if (statComplete && fingerprintComplete) prerequisitesComplete ();
				}				
			}
	    });

		fs.stat (filePath, function (err, stat) {
			if (err) {
				//console.log ("Err from stat on file: " + filePath);
			} else {
				cacheRecord.rawSize = stat.size;
				cacheRecord.modified = stat.mtime;			
			}
			statComplete = true;
			if (dataComplete && fingerprintComplete) prerequisitesComplete ();
		});
	}
	
	// NOTE: does this work for binary data? it should....
	function serveDataWithEncoding (response, data, contentType, charset, encoding, modificationTime, fingerprint, maxAgeInSeconds) {
		var responseHeaders = {
			'Content-Length': data ? data.length : 0,
	        'Content-Type': contentType,
			'Vary': 'Accept-Encoding',
	        'Cache-Control': "max-age=" + maxAgeInSeconds,
			'Server': 'bastard/0.6.2'
		};
		if (encoding) responseHeaders['Content-Encoding'] = encoding;
		if (modificationTime) responseHeaders['Last-Modified'] = modificationTime;
		if (fingerprint) responseHeaders['Etag'] = fingerprint;
	    response.writeHead (200, responseHeaders);
	    response.end (data, charset);
	}

	function serve (response, filePath, basePath, fingerprint, gzipOK, raw, checkModTimeAgainstCache, ifModifiedSince, headOnly) {
		if (debug) console.info ("Serving " + basePath + ' out of ' + filePath);
		var cacheRecord = cacheData[filePath];

		if (checkModTimeAgainstCache && cacheRecord) {
			// we'll do the check and then call ourselves again.
			fs.stat (filePath, function (err, stat) {
				if (stat && stat.mtime != cacheRecord.modified) {
					delete cacheData[filePath];
				}
				serve (response, filePath, basePath, fingerprint, gzipOK, raw, false, ifModifiedSince, headOnly);
			});
			return;
		}

		function serveFromCacheRecord (cacheRecordParam, isRefill) {
			if (debug) console.info ("Serve " + basePath + " from cache record: " + formatCacheRecord (cacheRecordParam));
			if (gzipOK && cacheRecordParam.contentType && cacheRecordParam.contentType.indexOf ('image/') == 0) {
				gzipOK = false; // do not gzip image files.
			}
			
			function remakeCacheRecord () {
				if (debug) console.info ("Attempting to remake cache record: " + cacheRecordParam);
				prepareCacheForFile (filePath, basePath, function (newCacheRecord) {
					newCacheRecord.remade = true;
					serveFromCacheRecord (newCacheRecord);					
				});
			}
			
			
			function refillCacheRecord () {
				if (debug) console.info ("Attempting to refill cache record: " + cacheRecordParam);
				delete cacheRecordParam.reloaded;
				if (gzipOK) {
					fs.readFile (me.gzippedFileCacheDir + basePath + '.gz', null, function (err, fileData) {
						if (!err) {
							cacheRecord.gzip = fileData;
						}
						serveFromCacheRecord (cacheRecordParam, true);
					});
					return;
				}
				
				// not gzip; if we're not raw, get the regular processed data
				if (!raw) {
					fs.readFile (me.processedFileCacheDir + basePath, cacheRecord.charset, function (err, fileData) {
						if (!err) {
							cacheRecord.processed = fileData;
						}
						serveFromCacheRecord (cacheRecordParam, true);
					});
				}

				// get the raw data...
				fs.readFile (me.baseDir + basePath, cacheRecord.charset, function (err, fileData) {
					if (!err) {
						cacheRecord.raw = fileData;
					}
					serveFromCacheRecord (cacheRecordParam, true);
				});
				
			}
			
			var data;
			if (raw) data = cacheRecordParam.raw;
			else if (gzipOK) data = cacheRecordParam.gzip;
			else data = cacheRecordParam.processed;
			
			if (data == null && !headOnly) {
				if (debug) console.warn ("No data for " + basePath);
				if (cacheRecordParam.reloaded && !isRefill) { // if it is a reloaded record and we haven't tried yet
					refillCacheRecord ();
					return;
				}
				
				if (!cacheRecordParam.remade && !cacheRecordParam.fileError && !cacheRecordParam.fingerprintError) {
					// console.info ("Remaking...");
					remakeCacheRecord ();
					return;
				}
				
				// check the specific error. TODO: cover more cases here?
				var errorMessage;
				var errorCode;
				if (cacheRecordParam.fileError && cacheRecordParam.fileError.code == 'ENOENT') {
					errorCode = 404;
					errorMessage = "File not found.";
				} else if (cacheRecordParam.fileError && cacheRecordParam.fileError.code == 'EACCES') {
					errorCode = 403;
					errorMessage = "Forbidden.";
				} else {
					errorCode = 500;
					errorMessage = "Internal error.";
					console.error ("Problem serving " + filePath);
					if (cacheRecordParam.fileError) console.error ("File error: " + JSON.stringify (cacheRecordParam.fileError));
					if (cacheRecordParam.fingerprintError) console.error ("Fingerprint error: " + JSON.stringify (cacheRecordParam.fingerprintError));
				}
				
				if (errorHandler) {
					errorHandler (response, errorCode, errorMessage);
				} else {
				    response.writeHead (errorCode, {'Content-Type': 'text/plain; charset=utf-8', 'Server': 'bastard/0.6.2'});
				    response.end (errorMessage, 'utf8');
				}
				return;
			}

			// if we have a fingerprint and it does not match, it is probably best to redirect to the current version, right?
			// until we put in a mechanism for calling back out to the appserver for that, we'll just send an error.
			if (fingerprint && fingerprint != cacheRecordParam.fingerprint) {
				var errorMessage = "That file is out of date. Current fingerprint: " + cacheRecordParam.fingerprint;
				if (errorHandler) {
					errorHandler (response, 404, errorMessage);
				} else {
				    response.writeHead (404, {'Content-Type': 'text/plain; charset=utf-8', 'Server': 'bastard/0.6.2'});
				    response.end (errorMessage, 'utf8');
				}
				return;
			}
			
			var modificationTime = cacheRecordParam.modified;
			if (ifModifiedSince && modificationTime && modificationTime <= ifModifiedSince) {
				response.writeHead (304, {'Server': 'bastard/0.6.2'});
				response.end ();
			} else {
				if (headOnly) {
					if (cacheRecordParam.fileError) {
						console.info ("FILE ERROR:");
						console.info (cacheRecordParam.fileError);
						var errorMessage = "Not found.";
						if (errorHandler) {
							errorHandler (response, 404, errorMessage);
						} else {
						    response.writeHead (404, {'Content-Type': 'text/plain; charset=utf-8', 'Server': 'bastard/0.6.2'});
						    response.end (errorMessage, 'utf8');
						}
					} else {
						serveDataWithEncoding (response, null, cacheRecordParam.contentType, cacheRecordParam.charset, null, modificationTime, cacheRecordParam.fingerprint, null);						
					}
				} else {
					var cacheTime = fingerprint ? ONE_YEAR : ONE_WEEK;
					serveDataWithEncoding (response, headOnly ? '' : data, cacheRecordParam.contentType, cacheRecordParam.charset, gzipOK ? 'gzip' : null, modificationTime, cacheRecordParam.fingerprint, cacheTime);
				}
			}
		}

		if (cacheRecord) {
			serveFromCacheRecord (cacheRecord);
		} else {
			prepareCacheForFile (filePath, basePath, serveFromCacheRecord);
		}
	}
	
	me.getFingerprint = function (filePath, basePath, callback) {
		var callbackOK = callback instanceof Function;

		// if filePath is null but basePath is not, figure out filePath
		if (!filePath && basePath) filePath = baseDir + basePath; // TODO: does not work for virtualhosts
		if (debug) console.info ("Fingerprinting: " + filePath + " aka " + basePath);
		var cacheRecord = cacheData[filePath];

		if (!callbackOK) {
			if (cacheRecord) {
				if (debug) console.info ("Returning fingerprint from cache record: " + cacheRecord.fingerprint);
				return cacheRecord.fingerprint;
			} else {
				if (debug) console.info ("No cache record for fingerprinting " + filePath + ", so preparing cache record.");
				prepareCacheForFile (filePath, basePath);
				return null;
			}			
		}
		
		function serveFromCacheRecord (cacheRecordParam) {
			response.writeHead (200, {'Content-Type': 'text/plain', 'Server': 'bastard/0.6.2'});
		    response.end (errorMessage, 'utf8');
		}
		
		if (cacheRecord) {
			callback (cacheRecord.fingerprintErr, cacheRecord.fingerprint);
		} else {
			prepareCacheForFile (filePath, basePath, function (cacheRecord) {
				callback (cacheRecord.fingerprintErr, cacheRecord.fingerprint);
			});
		}
	}
	
	function matchingVirtualHostDir (host) {
		host = host.toLowerCase ();
		if (host in virtualHostDirs) return virtualHostDirs[host];
		host = host.substring (host.indexOf ('.') + 1);
		if (host in virtualHostDirs) return virtualHostDirs[host];
		return baseDir + config.defaultHost + "/";
	}
	
	
	var fingerprintPrefixLen = fingerprintURLPrefix.length;
	var urlPrefixLen = urlPrefix.length;
	var rawPrefixLen = rawURLPrefix.length;
	var directoryCheck = {};
	me.possiblyHandleRequest = function (request, response) {
		if (virtualHostMode) request.baseDir = matchingVirtualHostDir (request.headers.host);
		else request.baseDir = baseDir;

		// console.info ("PFC maybe handling: " + request.url);
		// console.info ('fup: ' + fingerprintURLPrefix);
		// console.info ('up: ' + urlPrefix);
		if (rawURLPrefix && request.url.indexOf (rawURLPrefix) == 0) {
			var basePath = request.url.substring (rawPrefixLen);
			var filePath = request.baseDir + basePath;
			if (debug) {
				console.info ("    raw basePath: " + basePath);
				console.info ("    raw filePath: " + filePath);
			}
			var acceptEncoding = request.headers['accept-encoding'];
			var gzipOK = acceptEncoding && (acceptEncoding.split(',').indexOf ('gzip') >= 0);
			var ifModifiedSince = request.headers['if-modified-since']; // fingerprinted files are never modified, so what do we do here?
			var headOnly = request.method == 'HEAD';
			serve (response, filePath, basePath, null, false, true, alwaysCheckModTime, ifModifiedSince, headOnly);
			return true;
		}

		if (request.url.indexOf (fingerprintURLPrefix) == 0) {
			var base = request.url.substring (fingerprintPrefixLen);
			var slashPos = base.indexOf ('/');
			var basePath = base.substring (slashPos + 1);
			var fingerprint = base.substring (0, slashPos)
			var filePath = request.baseDir + basePath;
			// console.info ("    fingerprint filePath: " + filePath);
			// console.info ("        fingerprint: " + fingerprint);
			var acceptEncoding = request.headers['accept-encoding'];
			var gzipOK = acceptEncoding && (acceptEncoding.split(',').indexOf ('gzip') >= 0);
			var ifModifiedSince = request.headers['if-modified-since']; // fingerprinted files are never modified, so what do we do here?
			var headOnly = request.method == 'HEAD';
			serve (response, filePath, basePath, fingerprint, gzipOK, false, alwaysCheckModTime, ifModifiedSince, headOnly);
			return true;
		}
		if (request.url.indexOf (urlPrefix) == 0) {
			var acceptEncoding = request.headers['accept-encoding'];
			var gzipOK = acceptEncoding && (acceptEncoding.split(',').indexOf ('gzip') >= 0);
			var ifModifiedSince = request.headers['if-modified-since']; // fingerprinted files are never modified, so what do we do here?
			var headOnly = request.method == 'HEAD';

			var basePath = request.url.substring (urlPrefixLen);
			
			if (basePath.length == 0 || basePath.charAt (basePath.length - 1) == '/') basePath += defaultFileName;

			var filePath = request.baseDir + basePath;
			if (debug) {
				console.info ("    filePath: " + filePath);
				console.info ("    basePath: " + basePath);
			}
			
			if (filePath in directoryCheck) {
				if (directoryCheck[filePath]) {
					filePath += "/" + defaultFileName;
					basePath += "/" + defaultFileName;
				}
				serve (response, filePath, basePath, null, gzipOK, false, alwaysCheckModTime, ifModifiedSince, headOnly);
			} else {
				fs.stat (filePath, function (err, statObj) {
					if (!err) {
						var isDir = statObj.isDirectory ();
						directoryCheck[filePath] = isDir;
						if (isDir) {
							filePath += "/" + defaultFileName;
							basePath += "/" + defaultFileName;
						}
					}
					serve (response, filePath, basePath, null, gzipOK, false, alwaysCheckModTime, ifModifiedSince, headOnly);
				});
			}
			
			return true;
		}
		// console.info ("NO MATCH: " + request.url);
		return false; // do not want
	}
	
	// TODO: fix this for virtual host mode
	var prefixLengthToRemove = baseDir.length;
	me.urlForFile = function (filePath) {
		var basePath = filePath.substring (prefixLengthToRemove);
		
		var fingerprint = me.getFingerprint (filePath, basePath);
		
		if (fingerprint) {
			return fingerprintURLPrefix + fingerprint + '/' + basePath;
		} else {
			return urlPrefix + basePath;
		}	
	}
	
	me.preload = function (callback) {
		// Make it so that no overly-expensive operations will happen during a client request.
		// Reading data from disk is ok, but not calculating fingerprints.
		if (debug) console.info ("Hi. preloading.");
		var callbackOK = callback instanceof Function;
		
		function walk (dir, callback) {
			if (debug) console.info ("Walking: " + dir);
			fs.readdir (dir, function (err, list) {
				if (err) return callback (err);
				var pending = list.length;
				if (!pending) return callback (null);
					list.forEach (function (file) {
					file = dir + '/' + file;
					fs.stat (file, function (err, stat) {
						if (stat && stat.isDirectory ()) {
							walk (file, function (err, res) {
								if (!--pending) callback (null);
							});
						} else {
							var cacheRecord = cacheData[file];
							if (cacheRecord) {
								//console.info ("Cache record exists for: " + file);
								if (!--pending) callback (null);
							} else {
								prepareCacheForFile (file, null, function (err, cacheRecord) {
									if (!--pending) callback (null);
								});
							}
						}
					});
				});
			});
		};
		
		if (me.ready) {
			walk (baseDir.substring (0, baseDir.length-1), callback);
		} else {
			me._emitter.once ('ready', function () {
				walk (baseDir.substring (0, baseDir.length-1), callback);				
			});
		}
	}
	
	me.cleanupForExit = function (tellMeWhenDone, eventName) {
		console.info ("\nCleaning up Bastard.");
		var trimmed = {};
		for (var fileName in cacheData) {
			var cacheRecord = cacheData[fileName];
			var record = {
				fingerprint: cacheRecord.fingerprint,
				rawSize: cacheRecord.rawSize,
				modified: cacheRecord.modified,
				contentType: cacheRecord.contentType,
				charset: cacheRecord.charset
			};
			trimmed[fileName] = record;
		}
		//console.info ("Will write data to: " + me.cacheInfoFilePath);
		fs.writeFile (me.cacheInfoFilePath, JSON.stringify (trimmed), 'utf8', function (err) {
			if (err) {
				console.info ("Problem writing :" + me.cacheInfoFilePath + ': ' + err.message);
			}
			if (tellMeWhenDone && eventName) tellMeWhenDone.emit (eventName);
		});
		
	}
}


exports.Bastard = Bastard;