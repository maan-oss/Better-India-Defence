# Demonstration assets

Seeded into the **demo site only** on first run (`src/demo/demoContent.ts`), so the identity register,
evidence library and a live face-capture camera have content to show. Never used on a configured site.

- `subject-a.jpg`, `subject-b.jpg` — **synthetic** faces of people who do not exist, from SFHQ-Tiny
  (`canva999888/SFHQ-Tiny-512-Part1`, Apache-2.0). No real person's biometric data is shipped.
- `scene.jpg` — frame from the VisDrone2019 MOT dataset (Zhu et al.), CC BY-SA 3.0, rescaled to 1280×720.
- `subject-a-cctv.jpg` — derived composite of `subject-a` onto `scene.jpg` with noise, blur and JPEG
  compression. CC BY-SA 3.0.
