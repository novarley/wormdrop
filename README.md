# Túnel: transferencia de archivos en tiempo real entre dos PC

Abre la página en un PC, copia el enlace, ábrelo en el otro PC y arrastra archivos. Viajan directo entre los dos navegadores (WebRTC, cifrado DTLS) y no se guardan en ningún servidor.

## Estructura

```
index.html        Interfaz y lógica de conexión y transferencia
api/config.js     Función de Vercel que entrega los servidores STUN/TURN
api/relay.js      Sala en la nube (plan B) sobre Vercel Blob
package.json      Dependencia @vercel/blob (Vercel la instala sola)
```

## Publicar en Vercel

1. Sube la carpeta a un repositorio de GitHub e impórtalo en vercel.com (Framework: **Other**, sin comando de build).
   O desde la terminal, dentro de la carpeta: `npx vercel --prod`
2. Abre la URL que te da Vercel. Listo para la misma red.

## Imprescindible para PCs en redes distintas: configurar TURN

Cuando los dos PC están en redes diferentes (oficina, datos móviles, routers con NAT estricto) la conexión directa suele bloquearse. Hace falta un servidor de relé TURN. El relé público que trae de respaldo no es confiable, así que configura uno de estos en **Vercel → Project → Settings → Environment Variables** y vuelve a desplegar:

**Opción A, Cloudflare (recomendada, tiene capa gratuita)**
En el panel de Cloudflare: Realtime → TURN Server → crear clave.
- `CF_TURN_KEY_ID` = Turn Token ID
- `CF_TURN_API_TOKEN` = API Token

**Opción B, Metered.ca**
- `METERED_DOMAIN` = por ejemplo `miapp.metered.live`
- `METERED_API_KEY` = tu API key

**Opción C, servidor propio (coturn)**
- `TURN_URLS` = `turn:mi-servidor.com:3478,turns:mi-servidor.com:5349`
- `TURN_USERNAME`, `TURN_CREDENTIAL`

## Plan B: sala en la nube (Vercel Blob)

Si los PC no logran conectarse directo, en la misma página hay una sección "Sala en la nube". Un PC sube el archivo y el otro lo ve aparecer en su lista (se actualiza cada 6 segundos) y lo descarga. Acepta cualquier tipo de archivo, se sube en partes de 4 MB con reintentos y se verifica con SHA-256 al descargar.

Para activarla, una sola vez:
1. En Vercel abre el proyecto, pestaña **Storage**, **Create Database**, elige **Blob** y créalo (público o privado, funcionan ambos).
2. Conéctalo al proyecto. Vercel añade sola la variable `BLOB_READ_WRITE_TOKEN`.
3. Ve a Deployments y haz **Redeploy**.

Variables opcionales:
- `RELAY_MAX_MB` tamaño máximo por archivo (por defecto 100)
- `RELAY_TTL_HOURS` horas antes del borrado automático (por defecto 24)

Los archivos solo los ve quien tenga el enlace de la sala. Cualquiera en la sala puede borrarlos con el botón Borrar. La limpieza de archivos vencidos se hace cada vez que alguien abre la sala. Revisa en el panel de Vercel los límites de almacenamiento de tu plan.

## Cómo comprobar que funciona

- El panel superior muestra el nombre del otro PC, la ruta (directa o por relé) y la latencia.
- En "Servidor de relé" debe aparecer Cloudflare TURN, Metered TURN o TURN propio.
- Prueba del relé: abre `https://tu-app.vercel.app/?relay=1#sala` en ambos PC. Fuerza el uso de TURN; si conecta así, funcionará entre cualquier red.
- "Diagnóstico de conexión" (abajo) registra cada paso: estado ICE, relés que no responden, errores.

## Qué confirma cada transferencia

1. El receptor acepta el archivo antes de empezar.
2. Cada 512 KB el receptor confirma lo recibido (barra verde en el emisor).
3. Al terminar se compara el tamaño y la huella SHA-256 (archivos de hasta 300 MB).
4. El emisor ve "Entregado y verificado en el otro PC" o un error concreto.

Si la conexión se corta, los archivos pendientes se reenvían solos al reconectar.
