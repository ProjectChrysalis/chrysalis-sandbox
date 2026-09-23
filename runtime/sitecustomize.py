# Loaded at interpreter start (the standard library zip carries it).
#
# A WASI process starts in "/", so the shell's directory is applied here.
# WASI has no sockets and no processes, so urllib's HTTP(S) handlers and the
# subprocess/os.system family are routed to the sandbox host through the
# /dev/host device: one request line out, one JSON answer back. Both hooks
# install when their module is first imported, so a script that never uses
# them pays nothing.
import os
import sys

_pwd = os.environ.get("PWD")
if _pwd:
    try:
        os.chdir(_pwd)
    except OSError:
        pass


def _host(verb, payload):
    import json

    line = verb.encode() + b" " + json.dumps(payload).encode() + b"\n"
    with open("/dev/host", "r+b", buffering=0) as port:
        port.write(line)
        answer = port.read()
    return json.loads(answer.decode() or "{}")


def _b64(data):
    import base64

    return base64.b64encode(data).decode() if data else ""


def _unb64(text):
    import base64

    return base64.b64decode(text) if text else b""


# ---------------------------------------------------------------- urllib
def _patch_urllib(module):
    import io
    import email.message
    import urllib.error
    import urllib.response

    def _body_of(data):
        if data is None:
            return b""
        if isinstance(data, (bytes, bytearray)):
            return bytes(data)
        if isinstance(data, str):
            return data.encode("iso-8859-1")
        if hasattr(data, "read"):
            return data.read()
        return b"".join(bytes(chunk) for chunk in data)

    def _open(self, req):
        headers = dict(req.header_items())
        headers.setdefault("User-Agent", "Python-urllib/%d.%d" % sys.version_info[:2])
        answer = _host(
            "http",
            {
                "url": req.full_url,
                "method": req.get_method(),
                "headers": list(headers.items()),
                "body": _b64(_body_of(req.data)),
            },
        )
        if answer.get("error"):
            raise urllib.error.URLError(answer["error"])
        message = email.message.Message()
        for name, value in answer.get("headers", []):
            message[name] = value
        response = urllib.response.addinfourl(io.BytesIO(_unb64(answer.get("body"))), message, req.full_url, answer.get("status"))
        response.msg = answer.get("reason", "")
        return response

    # No ssl module in this build, so urllib never defined an HTTPS handler
    # and build_opener() would not install one. TLS is the engine's side of
    # the request anyway.
    import http.client

    if not hasattr(http.client, "HTTPSConnection"):
        http.client.HTTPSConnection = http.client.HTTPConnection
    if not hasattr(module, "HTTPSHandler"):

        class HTTPSHandler(module.AbstractHTTPHandler):
            def __init__(self, debuglevel=None, context=None, check_hostname=None):
                super().__init__(debuglevel)

            https_request = module.AbstractHTTPHandler.do_request_

        module.HTTPSHandler = HTTPSHandler
    module.HTTPHandler.http_open = _open
    module.HTTPSHandler.https_open = _open


# ------------------------------------------------------------ subprocess
def _spawn(args, shell, cwd, env, data):
    if isinstance(args, (str, bytes)):
        args = os.fsdecode(args)
        payload = {"command": args} if shell else {"argv": [args]}
    else:
        argv = [os.fsdecode(a) for a in args]
        if shell:
            payload = {"command": argv[0], "args": argv[1:]}
        else:
            payload = {"argv": argv}
    payload["cwd"] = os.fsdecode(cwd) if cwd else os.getcwd()
    payload["env"] = dict(env) if env is not None else dict(os.environ)
    payload["stdin"] = _b64(data)
    answer = _host("spawn", payload)
    if answer.get("error"):
        raise FileNotFoundError(2, answer["error"], payload.get("argv", [payload.get("command")])[0])
    return answer.get("code", 1), _unb64(answer.get("stdout")), _unb64(answer.get("stderr"))


def _patch_subprocess(module):
    import io as io_mod

    PIPE, STDOUT, DEVNULL = module.PIPE, module.STDOUT, module.DEVNULL

    def _deliver(value, target, fallback):
        if target is None:
            stream = fallback
            stream.flush()
            try:
                stream.buffer.write(value)
                stream.buffer.flush()
            except AttributeError:
                stream.write(value.decode(errors="replace"))
            return None
        if target in (PIPE, STDOUT):
            return value
        if target == DEVNULL:
            return None
        if isinstance(target, int):
            os.write(target, value)
        else:
            target.write(value if "b" in getattr(target, "mode", "b") else value.decode(errors="replace"))
        return None

    class Popen:
        def __init__(self, args, bufsize=-1, executable=None, stdin=None, stdout=None, stderr=None, preexec_fn=None,
                     close_fds=True, shell=False, cwd=None, env=None, universal_newlines=None, startupinfo=None,
                     creationflags=0, restore_signals=True, start_new_session=False, pass_fds=(), *, text=None,
                     encoding=None, errors=None, user=None, group=None, extra_groups=None, umask=-1,
                     pipesize=-1, process_group=None):
            self.args = args
            self._spec = (args, shell, cwd, env)
            self._stdin, self._stdout, self._stderr = stdin, stdout, stderr
            self._text = bool(text or universal_newlines or encoding or errors)
            self._encoding = encoding or "utf-8"
            self._errors = errors or "strict"
            self.returncode = None
            self.pid = 1
            self.stdin = self.stdout = self.stderr = None
            self._out = self._err = None
            if stdin is PIPE:
                self._input = io_mod.BytesIO()
                self.stdin = self._input if not self._text else io_mod.TextIOWrapper(self._input, encoding=self._encoding, write_through=True)
            else:
                self._input = None
            if stdin is None or stdin is PIPE:
                self._pending = None
            else:
                self._pending = stdin.read() if hasattr(stdin, "read") else os.read(stdin, 1 << 30) if isinstance(stdin, int) and stdin >= 0 else b""
                if isinstance(self._pending, str):
                    self._pending = self._pending.encode(self._encoding)
            if stdin is not PIPE:
                self._run(self._pending or b"")

        def _run(self, data):
            code, out, err = _spawn(*self._spec, data)
            self.returncode = code
            out_value = _deliver(out, self._stdout, sys.stdout)
            if self._stderr is STDOUT and out_value is not None:
                out_value += err
                err_value = None
            else:
                err_value = _deliver(err, self._stderr, sys.stderr)
            self._out, self._err = out_value, err_value
            wrap = (lambda b: io_mod.TextIOWrapper(io_mod.BytesIO(b), encoding=self._encoding, errors=self._errors)) if self._text else io_mod.BytesIO
            if self._stdout is PIPE:
                self.stdout = wrap(out_value or b"")
            if self._stderr is PIPE:
                self.stderr = wrap(err_value or b"")

        def _decode(self, value):
            if value is None or not self._text:
                return value
            return value.decode(self._encoding, self._errors).replace("\r\n", "\n")

        def communicate(self, input=None, timeout=None):
            if self.returncode is None:
                data = self._input.getvalue() if self._input is not None else b""
                if input is not None:
                    data += input.encode(self._encoding) if isinstance(input, str) else input
                self._run(data)
            out = self._out if self._stdout is PIPE else None
            err = self._err if self._stderr is PIPE else None
            return self._decode(out), self._decode(err)

        def wait(self, timeout=None):
            if self.returncode is None:
                self.communicate()
            return self.returncode

        def poll(self):
            return self.returncode

        def kill(self):
            pass

        terminate = kill

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            self.wait()

    def run(*popenargs, input=None, capture_output=False, timeout=None, check=False, **kwargs):
        if capture_output:
            kwargs["stdout"] = PIPE
            kwargs["stderr"] = PIPE
        if input is not None:
            kwargs["stdin"] = PIPE
        process = Popen(*popenargs, **kwargs)
        out, err = process.communicate(input)
        if check and process.returncode:
            raise module.CalledProcessError(process.returncode, process.args, output=out, stderr=err)
        return module.CompletedProcess(process.args, process.returncode, out, err)

    def call(*popenargs, timeout=None, **kwargs):
        return Popen(*popenargs, **kwargs).wait()

    def check_call(*popenargs, **kwargs):
        code = call(*popenargs, **kwargs)
        if code:
            raise module.CalledProcessError(code, kwargs.get("args", popenargs[0]))
        return 0

    def check_output(*popenargs, timeout=None, **kwargs):
        return run(*popenargs, stdout=PIPE, check=True, **kwargs).stdout

    def getstatusoutput(cmd, *, encoding=None, errors=None):
        result = run(cmd, shell=True, text=True, stdout=PIPE, stderr=STDOUT, encoding=encoding, errors=errors)
        out = result.stdout or ""
        return result.returncode, out[:-1] if out.endswith("\n") else out

    def getoutput(cmd, *, encoding=None, errors=None):
        return getstatusoutput(cmd, encoding=encoding, errors=errors)[1]

    module.Popen = Popen
    module.run = run
    module.call = call
    module.check_call = check_call
    module.check_output = check_output
    module.getstatusoutput = getstatusoutput
    module.getoutput = getoutput


def _system(command):
    code, out, err = _spawn(command, True, None, None, b"")
    for stream, value in ((sys.stdout, out), (sys.stderr, err)):
        if value:
            stream.flush()
            stream.buffer.write(value)
            stream.buffer.flush()
    return code << 8


def _popen(cmd, mode="r", buffering=-1):
    import io

    if mode not in ("r", "w"):
        raise ValueError("invalid mode %r" % mode)
    if mode == "r":
        _, out, _ = _spawn(cmd, True, None, None, b"")
        return io.TextIOWrapper(io.BytesIO(out), encoding="utf-8")

    class _Writer(io.StringIO):
        def close(self):
            data = self.getvalue().encode()
            super().close()
            _, out, _ = _spawn(cmd, True, None, None, data)
            sys.stdout.write(out.decode(errors="replace"))

    return _Writer()


os.system = _system
os.popen = _popen


# ------------------------------------------------------- import hooks
class _PatchOnImport:
    targets = {"urllib.request": _patch_urllib, "subprocess": _patch_subprocess}

    @classmethod
    def find_spec(cls, name, path=None, target=None):
        patch = cls.targets.get(name)
        if patch is None:
            return None
        from importlib.machinery import PathFinder

        spec = PathFinder.find_spec(name, path)
        if spec is None or spec.loader is None:
            return spec
        spec.loader = _PatchedLoader(spec.loader, patch)
        return spec


class _PatchedLoader:
    def __init__(self, inner, patch):
        self.inner = inner
        self.patch = patch

    def create_module(self, spec):
        return self.inner.create_module(spec) if hasattr(self.inner, "create_module") else None

    def exec_module(self, module):
        self.inner.exec_module(module)
        self.patch(module)

    def __getattr__(self, name):
        return getattr(self.inner, name)


sys.meta_path.insert(0, _PatchOnImport)
del _pwd
