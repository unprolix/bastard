#!/usr/bin/env node

'use strict';

var fs = require ('fs');

var PACKAGE_DIR = arguments[4] + '/';
var PACKAGE_FILE = PACKAGE_DIR + 'package.json';

function currentVersion () {
	try {
		var packageJSON = JSON.parse (fs.readFileSync (PACKAGE_FILE));
		return packageJSON.version;
	}
	catch (err) {
		return 'ERROR';
	}
}

var RE = new RegExp ('bastard/\\d\.\\d\.\\d');
var VERSION = currentVersion ();

function performReplacement (file) {
	var data = fs.readFileSync (file, 'utf8');
	var modifiedData = data.replace (RE, 'bastard/' + VERSION);
	if (data != modifiedData) {
		fs.writeFileSync (file, data, 'utf8');
		console.info ("Updated file: " + file);		
	}
}


function replaceInFiles (callback) {
	var dir = PACKAGE_DIR;
	fs.readdir (dir, function (err, list) {
		if (err) return callback (err);
		var remaining = list.length;
		list.forEach (function (file) {
			if (!(file.lastIndexOf ('.js') == file.length - 3)) {
				if (--remaining <= 0) callback ();
				return;
			}
			file = dir + '/' + file;
			fs.stat (file, function (err, stat) {
				if (stat && stat.isFile ()) {
					performReplacement (file);
				}
				if (--remaining <= 0) callback ();
			});
		});
	});
}

replaceInFiles (function (err) {
	if (err) console.error (err);
	else console.info ("Version updated to " + VERSION);
});
