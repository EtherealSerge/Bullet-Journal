import os
import zlib
import struct

def make_chunk(chunk_type, chunk_data):
    crc = zlib.crc32(chunk_type + chunk_data) & 0xffffffff
    return struct.pack('>I', len(chunk_data)) + chunk_type + chunk_data + struct.pack('>I', crc)

def make_png(width, height, color_func):
    # Signature
    png = b'\x89PNG\r\n\x1a\n'
    
    # IHDR (width, height, 8 bit-depth, 6 color-type: RGBA, 0 compression, 0 filter, 0 interlace)
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png += make_chunk(b'IHDR', ihdr_data)
    
    # IDAT
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0) # Filter type 0 (None)
        for x in range(width):
            r, g, b, a = color_func(x, y, width, height)
            raw_data.extend([r, g, b, a])
            
    compressed = zlib.compress(raw_data, level=9)
    png += make_chunk(b'IDAT', compressed)
    
    # IEND
    png += make_chunk(b'IEND', b'')
    
    return png

def bullet_journal_logo(x, y, w, h):
    # Center
    cx, cy = w / 2.0, h / 2.0
    dx = x - cx
    dy = y - cy
    dist = (dx*dx + dy*dy)**0.5
    
    # Deep indigo/slate gradient background
    # Radial factor
    r_factor = dist / (w * 0.707) # 0 at center, 1 at corner
    r_bg = int(24 + (15 - 24) * r_factor)
    g_bg = int(20 + (23 - 20) * r_factor)
    b_bg = int(37 + (42 - 37) * r_factor)
    
    # Draw a sleek neon cyan bullet ring and a solid center dot
    # Ring radius: 0.35 to 0.38 of width
    ring_inner = w * 0.33
    ring_outer = w * 0.38
    dot_radius = w * 0.10
    
    # Smooth antialiasing helper
    def smoothstep(edge0, edge1, x_val):
        t = max(0.0, min(1.0, (x_val - edge0) / (edge1 - edge0)))
        return t * t * (3.0 - 2.0 * t)

    # Let's check if inside the dot
    if dist < dot_radius:
        # Core bullet (electric cyan/blue)
        # Antialias edge
        alpha = int(255 * (1.0 - smoothstep(dot_radius - 1.5, dot_radius, dist)))
        # Cyan-blue gradient
        r = 56
        g = 189
        b = 248
        return r, g, b, alpha
        
    elif ring_inner <= dist <= ring_outer:
        # Ring pixels
        # Antialias outer and inner edges
        dist_from_mid = abs(dist - (ring_inner + ring_outer)/2.0)
        half_width = (ring_outer - ring_inner) / 2.0
        edge_dist = half_width - dist_from_mid
        alpha = int(255 * smoothstep(0.0, 1.5, edge_dist))
        
        # Neon violet/pink color for the ring
        r = 139
        g = 92
        b = 246
        return r, g, b, alpha
        
    else:
        # Background
        return r_bg, g_bg, b_bg, 255

def main():
    os.makedirs('icons', exist_ok=True)
    
    print("Generating 192x192 icon...")
    png_192 = make_png(192, 192, bullet_journal_logo)
    with open('icons/icon-192.png', 'wb') as f:
        f.write(png_192)
        
    print("Generating 512x512 icon...")
    png_512 = make_png(512, 512, bullet_journal_logo)
    with open('icons/icon-512.png', 'wb') as f:
        f.write(png_512)
        
    print("Icons generated successfully!")

if __name__ == '__main__':
    main()
