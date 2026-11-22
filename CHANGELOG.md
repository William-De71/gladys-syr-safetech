# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [0.1.0] - 2026-11-22

### Added

- **devices:** the SYR leak protection devices of the local network through their local JSON API (port 5333): SafeTech Connect, SafeTech+, Trio DFR/LS, Trio LS, SafeTech Lock, TRIO Lock, Hansgrohe Pontos Base and the same devices of other brands; addresses typed, the path (`/trio`, `/safe-tec`, `/pontos-base`) and the expert mode of the older firmwares found by the integration.
- **features:** the water supply as a switch (shut off and open the valve), leak sensor, alarm in words, leak protection profile as a select, flow, pressure, water temperature, meter, water used today, last and current water draw, battery level and battery low.
- **scenes:** triggers when a leak is detected, an alarm comes up or goes away, a warning comes up, a device stops answering or answers again; actions to select a profile, start the microleak test, clear the alarm and read the water used.
- **widgets:** the leak protection overview with buttons to shut the water off or open it again, clear the alarm and start the microleak test; the water used each of the last 14 days.
- **configuration:** addresses, reading every 10, 30 or 60 seconds, language, "Search and test" and "Diagnostic" buttons; English, French, German and Spanish.

[0.1.0]: https://github.com/William-De71/gladys-syr-safetech/releases/tag/v0.1.0
