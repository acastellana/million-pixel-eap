# v0.2.0
# { "Depends": "py-genlayer:latest" }
"""PixelVerifier — GenLayer AI verification for the Million Pixel Page.

On verify_pixel_placement():
  1. Fetches pixels.json from the live GitHub Pages site
  2. AI evaluates whether the pixel block is correctly placed with the expected image
  3. Returns verdict JSON (jobId, verified, reason)
     The relay script handles delivery to Base Sepolia via resolveViaRelayer().

Constructor args:
    website_url:  str  — GitHub Pages URL (e.g. https://acastellana.github.io/million-pixel-eap)
"""

from genlayer import *
import json


class PixelVerifier(gl.Contract):
    website_url: str
    owner:       Address

    def __init__(self, website_url: str, bridge_sender: str, target_chain_eid: int):
        # bridge_sender and target_chain_eid kept for constructor compat — unused in v0.2.0
        self.website_url = website_url
        self.owner       = gl.message.sender_address

    @gl.public.write
    def verify_pixel_placement(
        self,
        job_id: str,                   # bytes32 as 0x-prefixed hex string
        pixel_x: int,
        pixel_y: int,
        block_width: int,
        block_height: int,
        expected_image_url: str,
        agentic_commerce_address: str, # AgenticCommerce on Base Sepolia (kept for compat)
    ) -> str:
        """Verify a pixel placement. Returns verdict JSON. Relay delivers to Base Sepolia."""

        # Capture for closures
        url     = self.website_url
        px, py  = pixel_x, pixel_y
        bw, bh  = block_width, block_height
        img_url = expected_image_url

        def nondet():
            # Fetch the live pixels.json
            resp   = gl.nondet.web.get(f"{url}/pixels.json")
            pixels = json.loads(resp.body.decode())

            # Check if pixel block is present with matching coords and image
            for entry in pixels:
                if (
                    int(entry.get("x", -1))        == px
                    and int(entry.get("y", -1))     == py
                    and int(entry.get("width", 0))  == bw
                    and int(entry.get("height", 0)) == bh
                    and entry.get("imageUrl", "")   == img_url
                ):
                    return json.dumps({
                        "verified": True,
                        "jobId":    job_id,
                        "reason":   f"Pixel block at ({px},{py}) size {bw}x{bh} with correct image found on site.",
                    })

            return json.dumps({
                "verified": False,
                "jobId":    job_id,
                "reason":   f"Pixel block at ({px},{py}) size {bw}x{bh} with image {img_url} NOT found in pixels.json.",
            })

        # Leader fetches+evaluates; validators independently fetch+evaluate; results compared.
        result = gl.vm.run_nondet(nondet)

        # Handle both str and dict return types
        if isinstance(result, str):
            return result
        elif isinstance(result, dict):
            return json.dumps(result)
        else:
            return json.dumps({
                "verified": False,
                "jobId":    job_id,
                "reason":   f"Unexpected result type: {type(result).__name__}",
            })

    # ─── Views ────────────────────────────────────────────────────────────────

    @gl.public.view
    def get_config(self) -> dict:
        return {
            "website_url": self.website_url,
            "version":     "0.2.0",
        }
