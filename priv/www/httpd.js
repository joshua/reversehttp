function Url(maybeStr) {
    var r;
    if (maybeStr) {
	r = maybeStr.toString().match(Url.regex);
	if (!r) throw {error: "url_invalid", url: maybeStr};
    } else {
	r = [null, null, null, null, null, null, null, null, null, null, null];
    }

    this.url = r[0];
    this.protocol = r[2];
    this.username = r[4];
    this.password = r[5];
    this.host = r[6];
    this.port = r[7];
    this.pathname = r[8];
    this.querystring = r[9];
    this.fragment = r[10];
}

Url.regex = 
    /* Regex courtesy of https://code.poly9.com/trac/wiki/URLParser */
    /^((\w+):\/\/)?((\w+):?(\w+)?@)?([^\/\?:]+):?(\d+)?(\/?[^\?#]+)?\??([^#]+)?#?(\w*)/;

Url.prototype.getHostPort = function () {
    return this.host + (this.port ? ":" + this.port : "");
};

Url.prototype.getPathQuery = function () {
    return this.pathname + (this.querystring ? "?" + this.querystring : "");
};

Url.prototype.toString = function () {
    var r = [];
    if (this.protocol) { r.push(this.protocol + "://"); }
    if (this.username) {
	r.push(this.username);
	if (this.password) { r.push(this.password); }
	r.push("@");
    }
    if (this.host) { r.push(this.host); }
    if (this.port) { r.push(":" + this.port.toString()); }
    if (this.pathname) { r.push(this.pathname); }
    if (this.querystring) { r.push("?" + this.querystring); }
    if (this.fragment) { r.push("#" + this.fragment); }
    return r.join("");
};

function encode_utf8(s) {
    return unescape(encodeURIComponent(s));
}

function decode_utf8(s) {
    return decodeURIComponent(escape(s));
}

function parseHttpHeadersAndBody(o, sourceText) {
    o.headers = {};
    do {
	var tmp = sourceText.match(/([^:]+):[ \t]*([^\r\n]*)\r\n/);
	if (tmp != null) {
	    o.headers[tmp[1].toLowerCase()] = tmp[2];
	    sourceText = sourceText.substring(tmp[0].length);
	}
    } while (tmp != null);
    o.body = sourceText.substring(2);
}

var ReverseHttpAccessPoint = "/reversehttp";

function HttpRequest(replyUrl, sourceText) {
    this.replyUrl = replyUrl;
    var tmp = sourceText.match(/([^ ]+) ([^ ]+) HTTP\/([0-9]+\.[0-9]+)\r\n/);
    this.method = tmp[1].toLowerCase();
    this.rawPath = tmp[2];
    this.httpVersion = tmp[3];
    parseHttpHeadersAndBody(this, sourceText.substring(tmp[0].length));
    this.responseSent = false;
}

HttpRequest.prototype.respond = function (status, text, headers, body) {
    if (this.responseSent) {
	return;
    }

    var r = new HttpResponse(status, text, headers, body, this.httpVersion);
    new Ajax.Request(this.replyUrl,
		     { method: "post",
		       contentType: "message/http",
		       postBody: r.toString() });
    this.responseSent = true;
};

function formatHttpHeadersAndBody(lineList, headers, body) {
    var h = {};
    for (var key in headers) {
	h[key] = headers[key];
    }
    h["Content-length"] = encode_utf8(body).length;
    for (var key in h) {
	lineList.push(key + ": " + h[key]);
    }
    lineList.push("");
    lineList.push(body);
    return lineList.join("\r\n");
}

function HttpRelay(method, url, headers, body, ajaxOptions) {
    this.method = method;
    this.url = new Url(url);
    this.headers = Object.extend({}, headers);
    this.headers["Host"] = this.url.getHostPort();
    this.body = body;

    var o = Object.extend({}, ajaxOptions);
    Object.extend(o, { method: "post",
		       contentType: "message/http",
		       postBody: this.toString() });
    this.request = new Ajax.Request(ReverseHttpAccessPoint + "/_relay/"+this.url.getHostPort(), o);
}

HttpRelay.prototype.toString = function () {
    return formatHttpHeadersAndBody([this.method + " " + this.url.getPathQuery() + " HTTP/1.0"],
				    this.headers,
				    this.body);
};

function parseHttpResponse(sourceText) {
    var tmp = sourceText.match(/HTTP\/([0-9]+\.[0-9]+) ([0-9]+) ([^\r\n]*)\r\n/);
    var r = new HttpResponse(Number(tmp[2]), tmp[3], null, null, tmp[1]);
    parseHttpHeadersAndBody(r, sourceText.substring(tmp[0].length));
    return r;
}

function HttpResponse(status, text, headers, body, httpVersion) {
    this.status = status;
    this.text = text;
    this.headers = headers;
    this.body = body;
    this.httpVersion = httpVersion || "1.0";
}

HttpResponse.prototype.toString = function () {
    return formatHttpHeadersAndBody(["HTTP/" + this.httpVersion + " " +
				     this.status + " " + this.text],
				    this.headers,
				    this.body);
};

function parseLinkHeaders(s) {
    var result = {};
    if (s != null) {
	var headerValues = s.split(", ");
	for (var i = 0; i < headerValues.length; i++) {
	    var linkHeader = headerValues[i];
	    var pieces = linkHeader.split(";");
	    var url;
	    var rel;
	    for (var j = 0; j < pieces.length; j++) {
		var piece = pieces[j];
		var m = piece.match(/<\s*(\S+)\s*>/);
		if (m != null) {
		    url = m[1];
		} else {
		    m = piece.match(/(\w+)="(\w*)"/);
		    if (m != null) {
			if (m[1].toLowerCase() == "rel") {
			    rel = m[2];
			}
		    }
		}
	    }
	    if (rel && url) {
		result[rel] = url;
	    }
	}
    }
    return result;
}

function HttpServer(label, callback, options) {
    var $elf = this;

    this.label = label;
    this.failureDelay = 2000;
    this.callback = callback;
    this.options = {
	token: "-",
	debug: function () {},
	log: function () { this.debug.apply(this, arguments); },
	onLocationChanged: function () {}
    };
    Object.extend(this.options, options || {});

    this.running = true;
    this.nextReq = null;
    this.location = null;
    this.pollRequest = null;

    // Avoid endlessly-spinning loading-indicator in Safari.
    setTimeout(function () {
		   $elf.options.debug("Declaring label " + label);
		   $elf.serve();
	       }, 250);
}

HttpServer.prototype.stop = function () {
    this.running = false;
    if (this.pollRequest) {
	if (this.pollRequest.transport) {
	    this.pollRequest.transport.abort();
	}
	this.pollRequest = null;
    }
};

HttpServer.prototype.repeatWithBackoff = function (requestBuilder, responseHandler) {
    var $elf = this;

    if (!$elf.running) {
	return;
    }

    this.pollRequest = requestBuilder(receiveReply);

    function receiveReply(ajaxRequest) {
	this.pollRequest = null;

	if (!$elf.running) {
	    return;
	}

	if ((ajaxRequest.status < 200 || ajaxRequest.status >= 300) &&
	    (ajaxRequest.status != 1223 /* MSIE returns this sometimes instead of 204! */))
	{
	    $elf.options.debug("Poll request failed - status " + ajaxRequest.status +
			       "; delaying " + $elf.failureDelay);
	    setTimeout(function () { $elf.serve(); }, $elf.failureDelay);
	    if ($elf.failureDelay < 30000) {
		$elf.failureDelay = $elf.failureDelay * 2;
	    }
	    return;
	}

	if ($elf.failureDelay != 2000) {
	    $elf.options.debug("Recovered; resetting delay");
	}
	$elf.failureDelay = 2000;

	responseHandler(ajaxRequest);
    }
};

HttpServer.prototype.serve = function () {
    var $elf = this;

    var declareMode = ($elf.nextReq == null);
    $elf.repeatWithBackoff(requestBuilder, responseHandler);

    function requestBuilder(receiveReply) {
	if (declareMode) {
	    return new Ajax.Request(ReverseHttpAccessPoint,
				    { method: "post",
				      onComplete: receiveReply,
				      parameters: {"name": $elf.label,
						   "token": $elf.options.token} });
	} else {
	    return new Ajax.Request($elf.nextReq,
				    { method: "get",
				      requestHeaders: ['Accept', 'message/http'],
				      onComplete: receiveReply });
	}
    }

    function responseHandler(ajaxRequest) {
	if (declareMode) {
	    var linkHeaders = parseLinkHeaders(ajaxRequest.getResponseHeader("Link"));
	    $elf.nextReq = linkHeaders["first"];
	    var locationText = linkHeaders["related"];
	    if (locationText) {
		$elf.location = locationText;
		$elf.options.onLocationChanged(locationText, $elf);
	    }
	    $elf.options.debug("Label " + $elf.label + " maps to " + $elf.location);
	    $elf.options.debug("First request is at " + $elf.nextReq);
	} else {
	    var requestSourceText = ajaxRequest.responseText;
	    if (requestSourceText) {
		try {
		    var clientHostAndPort = ajaxRequest.getResponseHeader("Requesting-Client");
		    var httpReq = new HttpRequest($elf.nextReq, requestSourceText);
		    $elf.nextReq = parseLinkHeaders(ajaxRequest.getResponseHeader("Link"))["next"];
		    $elf.options.log(httpReq.headers["host"] + " " + httpReq.method + " " + httpReq.rawPath);
		    try {
			$elf.callback(httpReq);
		    } catch (userException) {
			$elf.options.log("HTTPD CALLBACK ERROR: " + Object.toJSON(userException));
			httpReq.respond(500, {}, "httpd.js callback internal server error");
		    }
		} catch (catchallException) {
		    $elf.options.log("HTTPD ERROR: " + Object.toJSON(catchallException));
		}
	    }
	}
	if (Prototype.Browser.IE) {
	    // IE's stack runs out when things are busy if we don't do this.
	    setTimeout(function () { $elf.serve(); }, 0);
	} else {
	    $elf.serve();
	}
    }
};
