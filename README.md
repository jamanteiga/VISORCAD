# Visor CAD — formatos y puesta en marcha

## Qué abre y con qué motor

| Formato | Motor | Dónde se procesa |
|---|---|---|
| DXF | dxf-parser 1.1.2 + motor 2D propio (bloques, cotas, sombreados, splines, textos, capas, presentaciones) | Navegador |
| DWG (R13–2018+) | LibreDWG compilado a WASM (`@mlightcad/libredwg-web` 0.8.1, GPL-3.0) en Web Worker | Navegador |
| IPT, IAM, IDW, IPN, IPE, IDE | Lector OLE (cfb) → iProperties, miniatura PNG/BMP y lista de referencias | Navegador |
| IPT, IAM, IDW, IPN (geometría) | Autodesk APS Model Derivative → SVF2 + Autodesk Viewer 7 | Nube Autodesk (vía proxy) |
| STEP, STP, IGES, IGS, BREP | OpenCascade WASM (`occt-import-js` 0.0.23, LGPL) | Navegador |
| OBJ, STL, PLY, FBX, GLB, glTF | three.js r128 | Navegador |
| IFC, DGN, RVT, NWD, F3D, SLDPRT… y DWG que LibreDWG no lea | Autodesk APS | Nube Autodesk (vía proxy) |
| ZIP (ensamblaje empaquetado) | APS con archivo raíz seleccionable | Nube Autodesk (vía proxy) |

La geometría de Inventor no tiene especificación pública ni lector libre: en local se muestran miniatura y propiedades; la geometría real requiere APS.

## Ensamblajes y planos (IAM / IDW / IPN)

Abre el documento junto con sus piezas: **Abrir** (selección múltiple), **Carpeta** (carpeta del proyecto) o arrastrando la carpeta. El visor detecta los documentos raíz, comprueba qué referencias están presentes (panel izquierdo), las empaqueta en un ZIP (recursivo para subensamblajes) y lo envía a APS con `rootFilename`. Las conversiones se cachean por contenido (SHA-256): reabrir el mismo archivo no vuelve a subirlo.

## Puesta en marcha de APS

1. **Aplicación APS**: aps.autodesk.com → *Sign in* → *Applications* → *Create application* → tipo *Server-to-Server App*. Copia *Client ID* y *Client Secret*. Revisa en tu cuenta las condiciones de consumo de Model Derivative.
2. **Función proxy en Supabase** (desde la carpeta que contiene `supabase/functions/aps-proxy/index.ts`):
   ```bash
   supabase login
   supabase link --project-ref <REF_PROYECTO>
   supabase secrets set APS_CLIENT_ID=xxxx APS_CLIENT_SECRET=yyyy VISOR_KEY=una-clave-larga
   supabase functions deploy aps-proxy --no-verify-jwt
   ```
   Opcionales: `APS_BUCKET` (clave de bucket propia), `ALLOWED_ORIGIN` (p. ej. `https://usuario.github.io` para restringir CORS).
3. **Visor**: botón **APS** → URL `https://<REF_PROYECTO>.supabase.co/functions/v1/aps-proxy` → Clave del visor = `VISOR_KEY` → **Probar conexión** → **Guardar**. Marca *Convertir automáticamente* si quieres que los archivos Inventor se conviertan al abrirlos.

El proxy es necesario: APS no admite peticiones directas desde el navegador para todos sus endpoints (CORS) y el *Client Secret* no debe estar en el HTML.

Acciones del proxy: `token` (viewables:read para el Viewer), `check`, `upload` (sube a OSS con `signeds3upload` y lanza el trabajo SVF2 2D+3D), `status`. Bucket con política `temporary` (30 días).

## Limitaciones conocidas

- LibreDWG no lee todos los DWG (en particular algunos R14/2000 complejos); en ese caso el visor ofrece **Intentar con Autodesk APS**.
- DWG/DXF: no se representan XLINE/RAY, sólidos ACIS (3DSOLID/REGION), MULTILEADER, TABLE ni WIPEOUT; se listan en *Propiedades → No representadas*. Sombreados con patrón se muestran como contorno con relleno translúcido.
- Masa/área/volumen de iProperties se muestran en las unidades internas de Inventor.
- Licencias: LibreDWG (GPL-3.0) y occt-import-js (LGPL-2.1) se cargan en tiempo de ejecución desde jsDelivr; tenlo en cuenta si distribuyes el visor comercialmente.
- Archivos muy grandes pueden superar los límites de memoria/tiempo de Supabase Edge Functions; en ese caso sube un ZIP más ligero o despliega el mismo código en otro runtime Deno.
