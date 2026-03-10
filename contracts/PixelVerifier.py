# v0.1.0
# { "Depends": "py-genlayer:latest" }
from genlayer import *
import json

class PixelVerifier(gl.Contract):
    website_url: str
    owner: Address
    
    def __init__(self, website_url: str):
        self.website_url = website_url
        self.owner = gl.message.sender_address
    
    @gl.public.write
    def verify_pixel_placement(self, job_id: str, pixel_x: int, pixel_y: int, 
                                block_width: int, block_height: int, 
                                expected_image_url: str) -> str:
        # Capture for closure
        url = self.website_url
        px, py = pixel_x, pixel_y
        bw, bh = block_width, block_height
        img_url = expected_image_url
        
        def nondet():
            # Fetch the pixels.json from the live website
            resp = gl.nondet.web.get(f"{url}/pixels.json")
            pixels = json.loads(resp.body.decode())
            # Check if the pixel block exists with correct image
            for entry in pixels:
                if (int(entry.get("x")) == px and int(entry.get("y")) == py 
                    and int(entry.get("width")) == bw and int(entry.get("height")) == bh
                    and entry.get("imageUrl") == img_url):
                    return json.dumps({"verified": True, "jobId": job_id})
            return json.dumps({"verified": False, "jobId": job_id})
        
        result_str = gl.eq_principle.strict_eq(nondet)
        return result_str
