import http.server
import socketserver
import webbrowser
import os
import sys

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    # Disable caching for developer convenience so code changes show immediately
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def main():
    os.chdir(DIRECTORY)
    
    # Ensure correct MIME type for PWA manifest and icons on Windows
    Handler.extensions_map.update({
        '.json': 'application/json',
        '.webmanifest': 'application/manifest+json',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
    })

    # Try starting the server on PORT, and increment port if busy
    port = PORT
    server = None
    while port < PORT + 100:
        try:
            socketserver.TCPServer.allow_reuse_address = True
            server = socketserver.TCPServer(("", port), Handler)
            break
        except OSError:
            print(f"Port {port} is busy, trying next port...")
            port += 1
            
    if not server:
        print("Error: Could not find an open port to start the server.")
        sys.exit(1)

    url = f"http://localhost:{port}"
    print("=" * 60)
    print(f" AETHER JOURNAL DEVELOPMENT SERVER ")
    print(f" Serving folder: {DIRECTORY}")
    print(f" Running at:     {url}")
    print("=" * 60)
    print(" Press Ctrl+C to stop the server.\n")

    # Automatically open the browser
    try:
      webbrowser.open(url)
    except Exception as e:
      print(f"Could not open browser automatically: {e}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Aether Journal server. Goodbye!")
        server.server_close()

if __name__ == '__main__':
    main()
