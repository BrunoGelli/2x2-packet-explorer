# Detector geometry and source provenance

The bundled geometry in `packet_explorer/data/tiles.json` and `channels.npz` derives from the four PacMon v4 JSON layouts at commit `2cf0e2c7db056dd205efb7f41616c1795fa9ea67`. Copyright © 2023 FERMI NATIONAL ACCELERATOR LABORATORY for the benefit of the DUNE Collaboration. PacMon distributes the layouts under the Apache License, Version 2.0. A copy is included in `packet_explorer/data/LICENSE-PacMon.txt`. The derived files store the physical tile position, pitch and electronics-to-raster mapping. [PacMon source](https://github.com/BrunoGelli/2x2Pacmon/tree/2cf0e2c7db056dd205efb7f41616c1795fa9ea67/layout)

To reproduce the bundled layout from that checkout, run `python scripts/build_geometry.py /path/to/2x2Pacmon/layout packet_explorer/data`. The script verifies the four original Git blob hashes.

The file clock follows the ordered per-IOG SYNC-83 and receipt-boundary conventions of the 2×2 movie maker. Packet Explorer implements the HDF5 index, queries and viewer independently. [Movie maker timing code](https://github.com/BrunoGelli/2x2-raw-event-display-movie-maker/blob/62290e2652d42abf1c9441abed62b103202696d9/raw_movie/_upstream/timing.py)
