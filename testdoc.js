#!/usr/bin/env node

var ghm = require("github-flavored-markdown")
var fs = require('fs')
var md = fs.readFileSync('README.md','utf8')
var html = ghm.parse(md)
fs.writeFileSync('readme.html',html)
