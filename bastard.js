	'use strict';

var events = require ('events');
var child_process = require ('child_process');
var fs = require ('fs');
var uglify = require ("uglify-js");
var csso = require ("csso");
var gzbz2 = require ("gzbz2");
var mime = require ('mime');
var html_minifier = require ('html-minifier')
/*

	
TODO:
	optionally upload fingerprinted files to S3
	generate S3 URLs for files
	allow preloading of all files into memory

*/

function minifyHTML (data) {
	return html_minifier.minify (data, {
		removeComments: true,
		removeCommentsFromCDATA: true,
		removeCDATASectionsFromCDATA: true,
		collapseWhitespace: true,
		collapseBooleanAttributes: true,
		removeAttributeQuotes: true,
		removeRedundantAttributes: true,
		removeEmptyAttributes: true,
		removeOptionalTags: true,
		removeEmptyElements: false		
	});
}

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

function gzip (data) {
	var compressor = new gzbz2.Gzip;
	compressor.init ({level: 9});
	var result0 = compressor.deflate (data/*, 'ascii'*/);
	var result1 = compressor.end ();

	var result = new Buffer (result0.length + result1.length);
	result0.copy (result, 0, 0);
	result1.copy (result, result0.length, 0);

	var percent = Math.floor ((result.length * 100 / data.length) * 100 + 0.5)/100;
	console.info ("Compression: " + data.length + " -> " + result.length + ' (' + percent + '%)');

	// TODO: don't return compressed version if it's bigger. (need two return values: format and result)
	return result;
}



function Bastard (config) {
	var me = this;

	var baseDir = config.base;
	var errorHandler = config.errorHandler;
	var storageDir = config.workingDir || '/tmp/bastard.dat';
	var debug = config.debug;
	var urlPrefix = config.urlPrefix;
	var rawURLPrefix = config.rawURLPrefix;
	var fingerprintURLPrefix = config.fingerprintURLPrefix;
	if (baseDir.charAt (baseDir.length-1) != '/') baseDir += '/';
	
	me._emitter = new events.EventEmitter ();
	setupStorageDir ();
	
	// console.info ("*** " + config.workingDir);
	// console.info ("*** " + storageDir);
	
	var CACHE_INFO_FILENAME = 'cache_info.json';
	var cacheData = {};
	if (errorHandler && !(errorHandler instanceof Function)) errorHandler = null;

	var preprocessors = {
		'.js': minifyJavascript,
		'.css': csso.justDoIt,
		'.html': minifyHTML
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
			// console.info ("Loading old cache");
			var remaining = 0;
			for (var filePath in oldCache) remaining++;
			// console.info ("Will check record count: " + remaining);
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
							//console.info ("Stored mtime: " + cacheWhen);
							//console.info ("  Live mtime: " + statObj.mtime);
							if (cacheWhen != statObj.mtime) return;
							//console.info ("**** ELIGIBLE FOR REUSE");
							record.reloaded = true;
							cacheData[path] = record; // keep the info but load the data on demand only.
						}
					}
					remaining--;
					if (remaining <= 0) {
						//console.info ("Checked all records.");
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
					console.warn ("Could not reload cache info: " + err);
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
		var cacheRecord = {};

		function writeCacheData (filePath, data) {
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
				//console.info ("Fingerprint: " + cacheRecord.fingerprint);
			}
			fingerprintComplete = true;
			if (dataComplete && statComplete) prerequisitesComplete ();
		});

		console.info ("Reading " + filePath + " with charset: " + charset + " for mime type: " + mimeType);
	    fs.readFile (filePath, charset, function (err, data) {
	        if (err) {
	            //console.log("Error from file " + filePath + ": " + err);
				cacheRecord.fileError = err;
	        } else {
				if (rawURLPrefix) cacheRecord.raw = data; // only keep it if we might be asked for it later
				
				if (!basePath) basePath = filePath.substring (baseDir.length);
				
				// console.info ("Preprocessor: " + preprocessor);
				cacheRecord.processed = (preprocessor) ? preprocessor (data, filePath) : data;
				writeCacheData (me.processedFileCacheDir + basePath, cacheRecord.processed);
				
				if (cacheRecord.contentType && cacheRecord.contentType.indexOf ('image/') != 0) {
					cacheRecord.gzip = gzip (cacheRecord.processed);
					writeCacheData (me.gzippedFileCacheDir + basePath + '.gz', cacheRecord.gzip);
				} else {
					console.info ("Not gzipping an image");
				}				
			}
			dataComplete = true;
			if (statComplete && fingerprintComplete) prerequisitesComplete ();
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
			'Server': 'bastard/0.5.6'
		};
		if (encoding) responseHeaders['Content-Encoding'] = encoding;
		if (modificationTime) responseHeaders['Last-Modified'] = modificationTime;
		if (fingerprint) responseHeaders['Etag'] = fingerprint;
	    response.writeHead (200, responseHeaders);
	    response.end (data, charset);
	}

	function serve (response, filePath, basePath, fingerprint, gzipOK, ifModifiedSince, headOnly) {
		// console.info ("Serving " + basePath + ' out of ' + filePath);
		var cacheRecord = cacheData[filePath];

		function serveFromCacheRecord (cacheRecordParam, isRefill) {
			// console.info ("Serve " + basePath + " from cache record: " + formatCacheRecord (cacheRecordParam));
			if (gzipOK && cacheRecordParam.contentType && cacheRecordParam.contentType.indexOf ('image/') == 0) {
				gzipOK = false; // do not gzip image files.
			}
			
			function remakeCacheRecord (gzip) {
				prepareCacheForFile (filePath, basePath, function (newCacheRecord) {
					newCacheRecord.remade = true;
					serveFromCacheRecord (newCacheRecord);					
				});
			}
			
			
			function refillCacheRecord (gzip) {
				// console.info ("Attempting to refill cache record: " + cacheRecordParam);
				delete cacheRecordParam.reloaded;
				if (gzip) {
					fs.readFile (me.gzippedFileCacheDir + basePath + '.gz', null, function (err, fileData) {
						if (!err) {
							cacheRecord.gzip = fileData;
						}
						serveFromCacheRecord (cacheRecordParam, true);
					});
					return;
				}
				
				// not gzip; get the regular processed data
				fs.readFile (me.processedFileCacheDir + basePath, cacheRecord.charset, function (err, fileData) {
					if (!err) {
						cacheRecord.processed = fileData;
					}
					serveFromCacheRecord (cacheRecordParam, true);
				});
			}
			
			var data = (gzipOK && cacheRecordParam.gzip) ? cacheRecordParam.gzip : cacheRecordParam.processed;
			
			if (data ==null && !headOnly) {
				// console.warn ("No data for " + basePath);
				if (cacheRecordParam.reloaded && !isRefill) { // if it is a reloaded record and we haven't tried yet
					refillCacheRecord (gzipOK);
					return;
				}
				
				if (!cacheRecordParam.remade && !cacheRecordParam.fileError && !cacheRecordParam.fingerprintError) {
					// console.info ("Remaking...");
					remakeCacheRecord (gzipOK);
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
					console.info (cacheRecordParam.fileError);
					console.info (cacheRecordParam.fingerprintError);
					if (cacheRecordParam.fileError) console.error ("File error: " + JSON.stringify (cacheRecordParam.fileError));
					if (cacheRecordParam.fingerprintError) console.error ("Fingerprint error: " + JSON.stringify (cacheRecordParam.fingerprintError));
				}
				
				if (errorHandler) {
					errorHandler (response, errorCode, errorMessage);
				} else {
				    response.writeHead (errorCode, {'Content-Type': 'text/plain; charset=utf-8', 'Server': 'bastard/0.5.6'});
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
				    response.writeHead (404, {'Content-Type': 'text/plain; charset=utf-8', 'Server': 'bastard/0.5.6'});
				    response.end (errorMessage, 'utf8');
				}
				return;
			}
			
			var modificationTime = cacheRecordParam.modified;
			if (ifModifiedSince && modificationTime && modificationTime <= ifModifiedSince) {
				response.writeHead (304, {'Server': 'bastard/0.5.6'});
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
						    response.writeHead (404, {'Content-Type': 'text/plain; charset=utf-8', 'Server': 'bastard/0.5.6'});
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
		var cacheRecord = cacheData[filePath];
		var callbackOK = callback instanceof Function;

		// if filePath is null but basePath is not, figure out filePath
		if (!filePath && basePath) filePath = baseDir + basePath;

		if (!callbackOK) {
			if (cacheRecord) {
				return cacheRecord.fingerprint;
			} else {
				prepareCacheForFile (filePath, basePath);
				return null;
			}			
		}
		
		function serveFromCacheRecord (cacheRecordParam) {
			response.writeHead (200, {'Content-Type': 'text/plain', 'Server': 'bastard/0.5.6'});
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
	
	var fingerprintPrefixLen = fingerprintURLPrefix.length;
	var urlPrefixLen = urlPrefix.length;
	me.possiblyHandleRequest = function (request, response) {
		// console.info ("PFC maybe handling: " + request.url);
		// console.info ('fup: ' + fingerprintURLPrefix);
		// console.info ('up: ' + urlPrefix);
		if (request.url.indexOf (fingerprintURLPrefix) == 0) {
			var base = request.url.substring (fingerprintPrefixLen);
			var slashPos = base.indexOf ('/');
			var basePath = base.substring (slashPos + 1);
			var fingerprint = base.substring (0, slashPos)
			var filePath = baseDir + basePath;
			// console.info ("    fingerprint filePath: " + filePath);
			// console.info ("        fingerprint: " + fingerprint);
			var acceptEncoding = request.headers['accept-encoding'];
			var gzipOK = acceptEncoding && (acceptEncoding.split(',').indexOf ('gzip') >= 0);
			var ifModifiedSince = request.headers['if-modified-since']; // fingerprinted files are never modified, so what do we do here?
			var headOnly = request.method == 'HEAD';
			serve (response, filePath, basePath, fingerprint, gzipOK, ifModifiedSince, headOnly);
			return true;
		}
		if (request.url.indexOf (urlPrefix) == 0) {
			var basePath = request.url.substring (urlPrefixLen);
			
			var filePath = baseDir + basePath;
			//console.info ("    filePath: " + filePath);
			var acceptEncoding = request.headers['accept-encoding'];
			var gzipOK = acceptEncoding && (acceptEncoding.split(',').indexOf ('gzip') >= 0);
			var ifModifiedSince = request.headers['if-modified-since']; // fingerprinted files are never modified, so what do we do here?
			var headOnly = request.method == 'HEAD';
			serve (response, filePath, basePath, null, gzipOK, ifModifiedSince, headOnly);
			return true;
		}
		// console.info ("NO MATCH: " + request.url);
		return false; // do not want
	}
	
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
		
		var callbackOK = callback instanceof Function;
		
		function walk (dir, callback) {
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