

**Horde Studio Lite** is a client app (front-end) for Stable Horde / hAIdra, implemented in **Python 3.10.0** with GUI in PyQt6, created with help of LLM models (Gemini 3.1 and GLM 5.3).
It is designed to work with three latest models: Anima Turbo/Krea 2 Turbo/Moss SFT. (The app was made solely for my personal purposes, sorry if something is missing)

- The app is implemented as a single-file .py (easier to update with an LLM that way). The size is 1.14 MB size (the code is properly optimized to prevent the issues by file size).
- It is portable but requires two subfolders (./data, ./output, will be created next to the .py file on the first startup).
- It is safe to run: only modifying/deleting files in its work folder (the subfolders specifically).
- The Horde API key, once added, is stored in ./data/key.txt

By default, the generated images will be stored in ./output/temp with the respective metadata in a separate .json (up to 10 stored at a time). You can enable saving directly into ./output, bypassing the temporary sorage. The "ghost" .jsons with no image are deleted automatically on startup.

<a href="[https://ibb.co/60Ygg4Nw](https://i.ibb.co/whyMMKYg/hl.jpg)"><img src="https://i.ibb.co/whyMMKYg/hl.jpg" alt="hl" border="0"></a>

#Unique features:
- In-app Gallery, and Images Editor for manual retouch (HDR and Bloom, Color Filters, cinematic lens flares placement; Depth Maps can be generated with Alchemy and utilized for further retouch Photoshop-like)
- Tile Upscale, Automatic1111-style (using SDXL-based models for each tile, since the main models won't work for Image-to-Image)
- Dragging the entire tags (sentences) across the input form, when Ctrl is pressed down
- Context Menus by right mouse click are implemented where applicable
- "Templates" system, to insert your current prompt in the middle of a larger one; also "Tag Lines" (pre-made text lines) insertion, both with its own Editor
- LoRAs are supported, with entries added through the respective Editor; LoRA lists are separate for different models and has "folders" system. For the "slider" type of LoRA, a horizontal slider can be enabled.
- Batch loading of multiple single-line prompts from clipboard (will be added to queue, respecting the current limit of concurrent requests), each inserted into the current template
- Requests to an LLM with your custom endpoint, using the generic OpenAI Chat Completion format. It can produce t2i prompts (designed to make in batch, parsed from XML tags), image captions, or i2v prompts. 
- A bridge to your browser with Horde's endpoint opened (so the app connects via your browser VPN extension)
- A bridge to SillyTavern (to send generation requests via Horde Studio), may be useful due to lack of some features in ST's own Horde implementation
- In the Image Edit, you can split an image horizontally/vertically, with optional gap width, and save two halves separately or copy into clipboard. (Why need that? Since Krea 2 Turbo can't work with references, split-screen samples are the only way to produce a pair of consistent images for first/last frames, when working with a video generation model such as Minimax H3)
- Three UI themes: 1. **Sarif Gold**, inspired by "Deus Ex: Human Revolution" game aesthetics; 2. **Oriental Spirit**, high-contrast Asia-style theme with red accents; 3. **SeeStation**, inspired by the software produced by Sony (such as GUI of PlayStation 3 console). The UI itself is adjustable: UI elements can be scaled up/down, an the border between left/right panels can be dragged.

Feel free to modify or fork the app, publish it as **freeware** in Google Play etc.

✨You can support the author of this published code, by sending Horde Kudos for:

XinXin#529157


