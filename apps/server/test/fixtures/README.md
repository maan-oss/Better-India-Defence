# Test fixtures

- `subject-a.jpg`, `subject-b.jpg` — **synthetic** faces of people who do not exist, from SFHQ-Tiny
  (`canva999888/SFHQ-Tiny-512-Part1`, Apache-2.0). Used for enrolment / matching tests so no real person's
  biometric data is stored in this repository.
- `scene.jpg` — frame from the VisDrone2019 MOT dataset (Zhu et al., `Voxel51/visdrone-mot`), CC BY-SA 3.0,
  rescaled to 1280×720.
- `subject-a-cctv.jpg` — derived: `subject-a` scaled to 190 px, rotated 4.6°, composited onto `scene.jpg`,
  with sensor noise, Gaussian blur and heavy JPEG compression (simulates a CCTV capture of the same
  synthetic subject). CC BY-SA 3.0 (derivative of `scene.jpg`).
