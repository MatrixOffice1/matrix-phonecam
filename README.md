# Matrix PhoneCam

Matrix PhoneCam transmite la cámara de un teléfono Android o iPhone a un navegador de Windows. El vídeo se envía por WebRTC directamente entre dispositivos siempre que la red lo permita; Node.js coordina el emparejamiento y retransmite únicamente mensajes de señalización.

Dominio previsto: **https://phonecam.matrixai.es**

## Estado real del proyecto

| Funcionalidad | Estado |
| --- | --- |
| Páginas de cámara y receptor | Implementadas: `/phone.html` y `/viewer.html`. |
| Emparejamiento | Implementado con códigos aleatorios privados y una conexión de teléfono y receptor por código. |
| Señalización WebSocket | Implementada en `/ws`, con validación del rol y del origen web, y aislamiento por código. |
| HTTPS público | Lo termina el proxy de Coolify; el contenedor sirve HTTP internamente. La configuración real del dominio, DNS y certificado se debe comprobar durante el despliegue. |
| WebRTC, ofertas/respuestas y candidatos ICE | Implementados, con cola de candidatos recibidos antes de la descripción SDP. |
| STUN | Configurado por defecto. STUN ayuda a descubrir direcciones de red; no retransmite el vídeo. |
| TURN | Compatible con credenciales temporales TURN REST. Necesita que el operador configure y proteja un servidor TURN externo. |
| 720p y 1080p | Resoluciones deseadas; se muestra el tamaño real que informa el teléfono. 1080p es el punto de partida recomendado. |
| 4K | Resolución deseada experimental, no garantizada. Depende del sensor, navegador, codificador, rendimiento y ancho de banda; puede reducirse automáticamente a 1080p o 720p ante un error de resolución. |
| Webcam seleccionable directamente en Zoom, Meet o Teams | No implementada como aplicación/controlador nativo. Se puede probar una ruta manual con OBS Virtual Camera (ver más abajo); no está verificada en este proyecto. |
| QR, audio y aplicaciones móviles nativas | No implementados. |

El servidor no graba, almacena ni recibe los paquetes de vídeo. La señalización puede incluir SDP y candidatos ICE, pero no las imágenes de la cámara. La conectividad directa no está garantizada en todas las redes; algunas redes necesitan un servidor TURN.

### Alcance del código privado

El código generado tiene 144 bits aleatorios y actúa como una credencial de acceso de tipo *bearer*: cualquiera que lo conozca puede intentar ocupar el único puesto de teléfono o de receptor de esa sesión. No publiques el código ni reutilices uno compartido; genera uno nuevo para cada sesión. El servidor no persiste las salas después de desconectarse sus participantes, pero no hay cuentas, expiración programada del código, lista de usuarios ni protección de identidad.

## Archivos del proyecto

- `Dockerfile`: imagen Node 22, puerto interno 3000, ejecución con usuario sin privilegios y comprobación de salud.
- `.dockerignore`: excluye dependencias locales, archivos de entorno, certificados y otros datos que no deben incluirse en la imagen.
- `.gitignore`: evita subir dependencias, secretos de entorno, certificados y ZIP locales al repositorio Git.
- `package.json` y `package-lock.json`: requieren Node.js 20 o posterior e incluyen comandos de comprobación y pruebas.
- `server.js`: servidor HTTP para el proxy TLS, endpoint `/health`, configuración ICE y señalización WebSocket limitada a `/ws`.
- `public/common.js`: código privado, configuración ICE y utilidades de señalización del navegador.
- `public/phone.js` y `public/viewer.js`: captura de cámara, negociación WebRTC, cola de candidatos y manejo de desconexión.
- `public/phone.html` y `public/viewer.html`: interfaz del teléfono y el receptor.
- `public/style.css`: estilos adaptables para móvil y ordenador.
- `test/server.test.js`: pruebas de rutas, emparejamiento privado, aislamiento, validación, señalización y credenciales TURN efímeras.

No se incluye `docker-compose.yml`: Coolify puede construir directamente el `Dockerfile`. Este método evita publicar un puerto del host o mantener una segunda configuración de despliegue.

## Despliegue en Coolify

### 1. Sube el proyecto a un repositorio Git

Instala Git si todavía no está disponible. Desde la carpeta del proyecto, crea un repositorio privado o público en GitHub/GitLab y sube la rama que quieras desplegar. Si la carpeta **ya tiene** un repositorio, conserva su configuración y añade un remoto en lugar de inicializarla de nuevo.

```powershell
git init
git add .
git commit -m "Prepare Matrix PhoneCam for Coolify"
git branch -M main
git remote add origin https://github.com/USUARIO/REPOSITORIO.git
git push -u origin main
```

Sustituye la URL por la del repositorio que hayas creado. No añadas archivos `.env`, contraseñas TURN, claves privadas ni certificados. El proyecto no necesita un archivo de variables de entorno para arrancar con la configuración predeterminada.

### 2. Crea la aplicación

1. En Coolify, añade una aplicación nueva asociada a tu proveedor Git y selecciona el repositorio y la rama.
2. Selecciona el método de construcción **Dockerfile** (no Docker Compose ni un despliegue estático). Usa el `Dockerfile` de la raíz del proyecto.
3. Comprueba que el puerto de destino o puerto expuesto de la aplicación sea **3000**. Este es el puerto interno del contenedor, no un puerto que debas publicar en el router o abrir al público. No añadas un mapeo de puerto del host: Coolify debe enrutar el tráfico por su proxy.
4. Configura el dominio de la aplicación como **`https://phonecam.matrixai.es`**.
5. Configura las variables de entorno explicadas en la sección siguiente y despliega.
6. Espera a que la aplicación quede activa y comprueba sus logs y su estado de salud.

El contenedor escucha en `0.0.0.0:3000`. Coolify/proxy termina HTTPS y reenvía HTTP al contenedor. La aplicación del navegador deriva automáticamente la dirección `wss://phonecam.matrixai.es/ws` cuando se abre desde HTTPS; el proxy debe conservar el soporte de WebSocket/Upgrade. La señalización usa la misma aplicación y puerto que las páginas web.

### 3. Variables de entorno

Configúralas en la sección de variables de entorno de la aplicación en Coolify. No las escribas en el repositorio.

| Variable | ¿Obligatoria? | Descripción |
| --- | --- | --- |
| `PORT` | No; predeterminado `3000`. | Puerto interno. Si lo cambias, cambia también el puerto expuesto y la comprobación de salud de la configuración de despliegue. Se recomienda conservar `3000`. |
| `PUBLIC_ORIGIN` | No, pero recomendada en producción. | Fija el origen permitido para WebSockets, por ejemplo `https://phonecam.matrixai.es`. Si se configura, debe coincidir exactamente con el origen que ven los usuarios y no debe incluir una ruta. |
| `STUN_URLS` | No. | Lista separada por comas de servidores STUN. Por defecto usa `stun:stun.l.google.com:19302`. |
| `TURN_URLS` | No. | Lista separada por comas de direcciones del servidor TURN, por ejemplo `turn:turn.example.es:3478?transport=udp`. |
| `TURN_SHARED_SECRET` | Obligatoria solo si configuras `TURN_URLS`. | Secreto compartido con TURN REST/coturn. Coolify lo mantiene en el servidor y la aplicación lo usa para generar credenciales temporales. No publiques ni registres su valor. |
| `TURN_CREDENTIAL_TTL_SECONDS` | No. | Vida de las credenciales TURN, entre 60 y 86400 segundos; predeterminado `3600`. |

Configurar `TURN_URLS` sin `TURN_SHARED_SECRET` es un error y evita que el servidor arranque correctamente; configurar únicamente el secreto sin direcciones TURN no activa TURN. No introduzcas credenciales TURN permanentes en HTML ni JavaScript: las credenciales temporales se entregan al navegador mediante `/api/ice-servers`.

**TURN opcional:** si STUN no basta en una red concreta, despliega y administra un servidor coturn/TURN separado. Configúralo para emitir credenciales TURN REST con el mismo secreto aleatorio fuerte establecido en `static-auth-secret`; permite en el firewall los puertos del servicio TURN y el rango UDP de retransmisión configurado en coturn. En Coolify, define `TURN_URLS` con el nombre DNS y puerto de ese servidor y `TURN_SHARED_SECRET` con el secreto correspondiente. Guarda ambos en los secretos/variables protegidas de Coolify, no en el repositorio, la configuración del frontend ni logs. TURN puede retransmitir el vídeo cuando no es posible la ruta directa, por lo que el tráfico puede consumir ancho de banda del servidor TURN y dejar de ser punto a punto.

### 4. Comprueba DNS, HTTPS y WebSockets

El despliegue no configura DNS ni demuestra que el certificado esté listo. Comprueba antes que el registro DNS de `phonecam.matrixai.es` apunte a tu servidor o destino indicado por Coolify:

- Si usas un registro `A`, su dirección IPv4 debe corresponder al servidor.
- Si usas `AAAA`, el IPv6 también debe llegar al servidor; elimina un `AAAA` antiguo o incorrecto si no prestas servicio por IPv6.
- Si tu proveedor o Coolify indica un `CNAME`, sigue exactamente el destino que te haya proporcionado.
- Los puertos de entrada **80 y 443** deben estar disponibles para el proxy y la emisión/renovación del certificado, según tu instalación.

Desde Windows puedes consultar los DNS y el estado de salud cuando el dominio ya apunte correctamente:

```powershell
Resolve-DnsName phonecam.matrixai.es
Test-NetConnection phonecam.matrixai.es -Port 443
Invoke-RestMethod https://phonecam.matrixai.es/health
```

El estado esperado en `/health` es HTTP 200 y un objeto JSON con `"ok": true`. Abre `https://phonecam.matrixai.es/phone.html` y `https://phonecam.matrixai.es/viewer.html` en un navegador y verifica que no haya advertencias del certificado. El certificado debe ser válido para `phonecam.matrixai.es`, de confianza y estar vigente. Si DNS, HTTPS o `/health` fallan, revisa la dirección configurada en Coolify, los registros DNS, la emisión del certificado y los logs del proxy y de la aplicación.

Para comprobar `wss://`, abre las herramientas de desarrollador del navegador en las páginas del dominio y revisa la pestaña **Network/Red**: al conectar, la petición a `/ws` debe recibir una respuesta de WebSocket **101 Switching Protocols**, sin errores de certificado, `403` por origen o `502` del proxy. `PUBLIC_ORIGIN`, si está configurada, debe ser exactamente `https://phonecam.matrixai.es`.

### 5. Consulta logs y resuelve errores

En Coolify, abre el recurso de la aplicación y consulta sus logs de despliegue/contenedor; revisa también los logs del proxy de Coolify si la aplicación arranca pero el dominio no responde.

- **El contenedor reinicia o no arranca:** verifica que la construcción use el `Dockerfile`, que el puerto sea `3000` y que no haya configurado `TURN_URLS` sin `TURN_SHARED_SECRET`.
- **502/504 o la salud falla:** verifica el puerto interno 3000 y los logs de inicio de la aplicación y del proxy.
- **La web carga, pero `/ws` falla:** verifica el soporte de WebSocket/Upgrade en el proxy, el origen `PUBLIC_ORIGIN` y la respuesta 101 en el navegador.
- **El navegador indica que no es un origen seguro o no ofrece permiso de cámara:** abre la página HTTPS real, concede permiso a la cámara y comprueba que no haya un proxy o certificado TLS inválido.
- **El móvil y el ordenador se detectan, pero no llega el vídeo:** comprueba que ambos usen el mismo código privado y estén conectados al mismo emparejamiento; prueba primero 720p/1080p y una red Wi-Fi sin aislamiento de clientes. Algunas NAT, redes corporativas y VPN necesitan TURN.
- **Cámara ocupada o permiso denegado:** cierra las aplicaciones que puedan usarla, concede el permiso al navegador y pulsa de nuevo el botón de inicio.
- **La calidad real es inferior a la elegida:** usa el tamaño real mostrado en la página del teléfono; la resolución del selector es solo un objetivo.

Evita copiar códigos de emparejamiento, credenciales TURN o secretos en informes y logs.

## Prueba de uso

1. Abre `https://phonecam.matrixai.es/phone.html` en el teléfono y permite acceso a la cámara.
2. Pulsa **Generar código privado**. Copia el código en el ordenador; compártelo únicamente por un canal privado y no lo publiques.
3. En Windows, abre `https://phonecam.matrixai.es/viewer.html`, pega exactamente el mismo código y pulsa **Conectar**.
4. Inicia primero con **1080p**; en la página del teléfono se indica la resolución y FPS que el navegador informa y en la página de Windows el tamaño del vídeo recibido.
5. Para terminar, pulsa **Detener** en el teléfono o **Desconectar** en el ordenador. Para una sesión nueva, genera y comparte un código nuevo.

El navegador debe permanecer abierto y el teléfono no debería bloquearse durante la transmisión. Safari/iOS y algunos navegadores móviles pueden limitar la cámara en segundo plano, los formatos o las resoluciones disponibles. Un selector 4K no comprueba ni garantiza 4K extremo a extremo; sensor, navegador, codificador, temperatura, batería, CPU, red y negociación WebRTC condicionan el resultado. Las redes con NAT simétrica, cortafuegos restrictivos, VPN o aislamiento Wi-Fi pueden impedir la ruta directa y requerir TURN. La aplicación no promete conectividad universal.

## Comprobaciones locales

Requisitos: Node.js 20 o posterior. En Windows, desde PowerShell en la carpeta del proyecto:

```powershell
npm ci
npm run check
npm test
npm start
```

El modo local sirve HTTP en `http://localhost:3000`. Para probar la cámara desde un teléfono, usa un dominio HTTPS o un certificado local de desarrollo de confianza para ese teléfono; el HTTP local puede servir las páginas pero no es un origen seguro para la cámara. `npm start` no crea un certificado ni publica la aplicación.

## Webcam virtual en Windows: prueba manual con OBS

El proyecto actual **no crea un dispositivo webcam de Windows**. Zoom, Google Meet y Teams no pueden seleccionar directamente el vídeo del navegador como si fuera un controlador de cámara virtual propio.

Como prueba manual futura, se puede instalar OBS Studio en Windows, crear una escena y añadir una fuente **Browser** con `https://phonecam.matrixai.es/viewer.html`. Abre **Interact** en esa fuente, pega el código privado y pulsa **Conectar**; configura la fuente/escena con la resolución deseada y selecciona **Start Virtual Camera** en OBS. Después, selecciona **OBS Virtual Camera** en Zoom, Meet o Teams. La transmisión debe probarse en el equipo real: esta configuración manual no equivale a una integración de OBS probada, una webcam nativa del producto o compatibilidad garantizada con todas las versiones de esas plataformas.

## Pruebas y limitaciones de este cambio

Las pruebas locales verifican sintaxis JavaScript, rutas HTTP, salud, configuración ICE, emparejamiento privado, límite de un dispositivo por rol, aislamiento entre códigos, validación de mensajes, rechazo de orígenes WebSocket distintos y generación de credenciales TURN temporales. No sustituyen una prueba física de captura de cámara, conectividad ICE, rendimiento 4K ni recepción del vídeo en Zoom/Meet/Teams.

La construcción real de la imagen Docker, el despliegue en Coolify, DNS, certificado HTTPS, transporte `wss://` detrás de tu proxy, pruebas con móviles/redes reales y el recorrido con OBS quedan pendientes de validación en el servidor y los dispositivos. El proyecto no tiene un repositorio Git configurado en esta carpeta; debes crear/conectar el tuyo para desplegarlo desde Coolify.
