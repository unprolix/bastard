#!/usr/bin/env node

'use strict';

var fs = require ('fs');

var PACKAGE_DIR = fs.realpathSync (arguments[4]);
var PACKAGE_FILE = PACKAGE_DIR + '/' + 'package.json';
var THIS_FILE = fs.realpathSync (arguments[3]);

function currentVersion () {
	try {
		var packageJSON = JSON.parse (fs.readFileSync (PACKAGE_FILE));
		return packageJSON.version;
	}
	catch (err) {
		return 'ERROR';
	}
}

var RE = new RegExp ('bastard/\\d*\.\\d*\.\\d*', 'g');
var VERSION = currentVersion ();

function performReplacement (file, callback) {
	var data = fs.readFileSync (file, 'utf8');
	var modifiedData = data.replace (RE, 'bastard/' + VERSION);
	if (data != modifiedData) {
		fs.writeFile (file, modifiedData, 'utf8', function (err) {
			if (err) console.error ("Problem updating " + file + ": " + err);
			else console.info ("Updated file: " + file);
			callback ();
		});
	} else {
		callback ();
	}
}


function replaceInFiles (callback) {
	var dir = PACKAGE_DIR;
	fs.readdir (dir, function (err, list) {
		if (err) return callback (err);
		var remaining = list.length;
		list.forEach (function (file) {
			file = dir + '/' + file;
			if (!(file.lastIndexOf ('.js') == file.length - 3) || file == THIS_FILE) {
				if (--remaining <= 0) callback ();
				return;
			}
			fs.stat (file, function (err, stat) {
				if (stat && stat.isFile ()) {
					performReplacement (file, function () {
						if (--remaining <= 0) callback ();						
					});
				} else {
					if (--remaining <= 0) callback ();
				}
			});
		});
	});
}

replaceInFiles (function (err) {
	if (err) console.error (err);
	else console.info ("Version updated to " + VERSION);
});
