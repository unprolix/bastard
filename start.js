#!/usr/bin/env node

var http = require ('http');
var fs = require ('fs');

var bastard = require ('./bastard.js');

function startBastard () {
	var base = process.env.npm_package_config_base;
	try {
		var statObj = fs.statSync (base);
		if (!statObj.isDirectory ()) {
			throw "Configured base directory (" + base + ") is not a directory. To change config: npm config set bastard:base /path/with/good/intentions";
		}
	}
	catch (err) {
		if (err.code == 'ENOENT') {
			throw "Configured base directory (" + base + ") does not exist. To change config: npm config set bastard:base /path/with/good/intentions";
		}
		throw "Problem accessing configured base directory (" + base + "): " + err.message + ". To change config: npm config set bastard:base /path/with/good/intentions";
	}

	var config = {
		base: base,
		debug: process.env.npm_package_config_debug == 'true',
		directories: process.env.npm_package_config_directories == 'true',
		rawURLPrefix: process.env.npm_package_config_rawURLPrefix,
		fingerprintURLPrefix: process.env.npm_package_config_fingerprintURLPrefix,
		urlPrefix: process.env.npm_package_config_urlPrefix
	};
	var bastardObj = new bastard.Bastard (config);
	
	var host = process.env.npm_package_config_host;
	var port = process.env.npm_package_config_port;
	
	if (host == 'null' || host == '') host = null;
	
	/*
	function test () {
		bastardObj.getFingerprint (null, '/html/example.html', function (err, fingerprint) {
			console.info ("FINGERPRINT: " + fingerprint);			
		});
		bastardObj.getFingerprint ('/Users/oao/src/fishing/base/html/example.html', null, function (err, fingerprint) {
			console.info ("FINGERPRINT: " + fingerprint);			
		});
	}
	*/

	function webServerRequest (request, response) {
		var handled = bastardObj.possiblyHandleRequest (request, response);
		if (!handled) {
			console.warn ("Request not handled by bastard: " + request.method + " " + request.url);
			response.writeHead (404, {'Content-Type': 'text/plain; charset=utf-8'});
            response.end ("Not found.");
		}
	}
	
	var httpServer = http.createServer ();
	httpServer.addListener ('request', webServerRequest);
	httpServer.listen (port, host, function () {
		if (host) console.log ('Server running at http://' + host + ':' + port + '/');
		else console.log ('Server running at port ' + port + '.');
		
		//test ();
		
		process.once ('SIGINT', function () {
			httpServer.close ();
			bastardObj.cleanupForExit ();
		});		
	});
    
}

startBastard ();