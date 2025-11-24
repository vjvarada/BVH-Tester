#!/usr/bin/env python3
"""
Simple HTTP server for Three.js Projected Offset Generator
Serves the application with proper CORS headers
"""

import http.server
import socketserver
import webbrowser
import sys
from pathlib import Path

PORT = 8000

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Add CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

def start_server():
    # Change to script directory
    script_dir = Path(__file__).parent
    sys.path.insert(0, str(script_dir))
    
    print("=" * 60)
    print("  Three.js Projected Offset Generator")
    print("=" * 60)
    print()
    print(f"🚀 Starting server on http://localhost:{PORT}")
    print()
    print("📝 Instructions:")
    print("  1. Upload an STL file (or use generated test files)")
    print("  2. Adjust offset distance as needed")
    print("  3. Click 'Generate Projected Offset'")
    print("  4. Toggle views to see results")
    print()
    print("🛑 Press Ctrl+C to stop the server")
    print()
    print("=" * 60)
    
    try:
        with socketserver.TCPServer(("", PORT), CORSRequestHandler) as httpd:
            # Open browser
            webbrowser.open(f'http://localhost:{PORT}')
            
            # Start serving
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n\n✓ Server stopped")
        sys.exit(0)
    except OSError as e:
        print(f"\n✗ Error: {e}")
        print(f"  Port {PORT} might already be in use.")
        print(f"  Try closing other applications or use a different port.")
        sys.exit(1)

if __name__ == "__main__":
    start_server()
