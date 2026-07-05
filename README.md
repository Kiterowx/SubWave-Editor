# SubWave

SubWave ajusta inicio y fin de archivos `.ass`, `.ssa` y `.srt` sobre la forma
de onda del audio. Permite seleccionar una linea, reposicionar sus extremos,
previsualizar el segmento y exportar el resultado.

Sitio público: <https://kitherow.github.io/SubWave-Editor/>

## Uso

SubWave trabaja con `.waveform.json` creados por **Waveform JSON** desde [Chrono Generators](https://github.com/Kitherow/Chrono-Generators-Scripts), subtitulos `.ass`, `.ssa` o `.srt`, y audio opcional para previsualizacion. La edicion se hace desde la linea de tiempo, la lista de subtitulos y el panel de tiempos. La exportacion conserva cabeceras, estilos y campos no editados cuando el formato de salida es ASS.

## Estructura

```text
src/
  pages/index.astro    interfaz y estilos
  lib/editor.ts        estado, render del waveform e interaccion
  lib/subtitles.ts     lectura/escritura de ASS y SRT
  lib/waveform.ts      modelo del waveform y muestreo
  lib/time.ts          conversion de tiempos
```
