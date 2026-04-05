require('dotenv').config({ override: false })

const express = require('express')
const path = require('path')
const fs = require('fs')
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const app = express()
const PORT = 3000

app.use('/style.css', (req, res, next) => {
  res.type('text/css')
  next()
})

app.use(express.static('public'))
app.use(express.json())

app.get('/', (req, res) => {
  res.type('html')
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.post('/guardar-medicion', async (req, res) => {
const nuevaMedicion = {
 
  sector: req.body.lote || '',
  vwc: Number(req.body.vwc),
  ec: Number(req.body.ec),
  ph: Number(req.body.ph),
  temperatura: Number(req.body.temperatura),
  humedad: Number(req.body.humedad),
  observaciones: req.body.notas || ''
}

  try {
    const { data, error } = await supabase
  .from('mediciones')
  .select('*')
  .order('created_at', { ascending: false })

    if (error) {
      console.error('Error guardando en Supabase:', error)
    }
  } catch (err) {
    console.error('Error guardando en Supabase:', err)
  }

  const ruta = path.join(__dirname, 'data.json')
  const contenido = fs.readFileSync(ruta, 'utf8')
  const mediciones = JSON.parse(contenido)

  mediciones.push(nuevaMedicion)

  fs.writeFileSync(ruta, JSON.stringify(mediciones, null, 2))

  res.json({ ok: true, mensaje: 'Medición guardada correctamente' })
})

app.get('/mediciones', async (req, res) => {

  const { data, error } = await supabase
    .from('mediciones')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) {
    console.error('Error leyendo mediciones:', error)
    return res.status(500).json({ error: error.message })
  }

  res.json(data)

})




const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage() })

app.post('/importar-csv', upload.single('archivo'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, mensaje: 'No se recibió archivo' })
  const contenido = req.file.buffer.toString('utf8')
  const lineas = contenido.split('\n').filter(l => l.trim())
  const filas = lineas.slice(1)
  const registros = []
  let saltadas = 0
  for (const fila of filas) {
    const cols = fila.split(',')
    if (cols.length < 6) continue
    const fecha = cols[0]?.trim()
    const ec = parseFloat(cols[3])
    const vwc = parseFloat(cols[4])
    const temp = parseFloat(cols[5])
    const notas = cols[11]?.trim() || ''
    if (vwc <= 6 || ec === 0) { saltadas++; continue }
    registros.push({ fecha, ec, vwc, temperatura: temp, notas, lote: notas || 'BlueLab Import' })
  }
  let insertados = 0
  const LOTE = 100
  for (let i = 0; i < registros.length; i += LOTE) {
    const chunk = registros.slice(i, i + LOTE)
    const { error } = await supabase.from('mediciones').insert(chunk)
    if (!error) insertados += chunk.length
  }
  const ruta = require('path').join(__dirname, 'data.json')
  const existentes = JSON.parse(require('fs').readFileSync(ruta, 'utf8'))
  require('fs').writeFileSync(ruta, JSON.stringify([...existentes, ...registros], null, 2))
  res.json({ ok: true, insertados, saltadas, total: filas.length })
})

// ── Endpoint análisis de foto BlueLab con Claude ──────────────────────────
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.post('/analizar-foto', upload.single('foto'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, mensaje: 'No se recibió imagen' })

  const loteId   = req.body.lote_id
  const loteNom  = req.body.lote || 'Sin lote'
  const fase     = req.body.fase || 'floracion'

  // Convertir imagen a base64
  const sharp = require("sharp"); const imgBuffer = await sharp(req.file.buffer).resize(1200, 1200, {fit:"inside"}).jpeg({quality:80}).toBuffer(); const base64 = imgBuffer.toString("base64"); const mime = "image/jpeg";

  // Targets de Carmelo según fase
  const targets = {
    vegetativo_temprano: { preRiego: 20, postRiego: 28 },
    vegetativo_avanzado: { preRiego: 24, postRiego: 33 },
    floracion:           { preRiego: 20, postRiego: 28 },
  }
  const target = targets[fase] || targets.floracion

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mime, data: base64 }
          },
          {
            type: 'text',
            text: `Sos un sistema agronomico de cultivo de cannabis en invernadero.

Analizá esta imagen de la pantalla del sensor BlueLab Pulse y extraé los valores de:
- EC (mS/cm)
- VWC o Humedad (%)
- Temperatura (°C)

Esta es la pantalla de historial de la app BlueLab Pulse. Muestra filas de mediciones. Cada fila tiene 3 columnas: COLUMNA IZQUIERDA = EC (numero con superindice EC), COLUMNA CENTRAL = VWC Humedad (numero con superindice % o asterisco), COLUMNA DERECHA = Temperatura (numero con superindice C). Lee cada fila de arriba hacia abajo. Extrae SOLO los numeros de la COLUMNA CENTRAL (VWC). Ignora la ultima fila si esta cortada. Suma todos los valores de VWC que pudiste leer completamente y divide por la cantidad de filas completas. Devuelve tambien cuantas filas leiste.

Respondé SOLO en este formato JSON exacto, sin texto adicional:
{
  "lecturas": {
    "ec_promedio": 0.0,
    "vwc_promedio": 0.0,
    "temp_promedio": 0.0,
    "cantidad_lecturas": 0
  }
}`
          }
        ]
      }]
    })

    const texto = response.content[0].text.trim()
    let analisis
    try {
      analisis = JSON.parse(texto.replace(/```json|```/g, '').trim())
    } catch {
      return res.json({ ok: false, mensaje: 'Error parseando respuesta de Claude', raw: texto })
    }

    // Guardar las lecturas en mediciones si hay lote_id
    if (loteId && analisis.lecturas) {
      const { ec_promedio, vwc_promedio, temp_promedio } = analisis.lecturas
      await supabase.from('mediciones').insert([{
        lote_id:     parseInt(loteId),
        lote:        loteNom,
        vwc:         vwc_promedio?.toString(),
        ec:          ec_promedio?.toString(),
        temperatura: temp_promedio?.toString(),
        notas:       'Importado desde foto BlueLab · Análisis IA',
        fecha:       new Date().toISOString()
      }])
    }

    // Lógica determinista de recomendación según fase
    const vwc = analisis.lecturas?.vwc_promedio || 0

    let regar = false
    let volumen = 0
    let motivo = ''

    if (fase === 'floracion') {
      if (vwc >= 27)      { regar = false; volumen = 0;   motivo = 'VWC '+vwc+'% — No regar (generativa)' }
      else if (vwc >= 25) { regar = true;  volumen = 400; motivo = 'VWC '+vwc+'% — Regar 400ml (generativa ~26%)' }
      else if (vwc >= 23) { regar = true;  volumen = 550; motivo = 'VWC '+vwc+'% — Regar 550ml (generativa ~24%)' }
      else if (vwc >= 21) { regar = true;  volumen = 700; motivo = 'VWC '+vwc+'% — Regar 700ml (generativa ~22%)' }
      else                { regar = true;  volumen = 800; motivo = 'VWC '+vwc+'% — Regar 800ml (generativa ~20%)' }
    } else {
      const t = targets[fase] || targets.floracion
      if (vwc >= t.preRiego) { regar = false; volumen = 0; motivo = 'VWC '+vwc+'% sobre target '+t.preRiego+'%' }
      else                   { regar = true;  volumen = 800; motivo = 'VWC '+vwc+'% bajo target '+t.preRiego+'%' }
    }

    analisis.recomendacion = { regar, volumen_ml_por_planta: volumen, motivo }
    analisis.diagnostico = {
      estado_vwc: vwc < 20 ? 'critico' : vwc < 24 ? 'bajo' : 'ok',
      diferencia_target: parseFloat((vwc - (targets[fase]?.preRiego || 20)).toFixed(1)),
      accion: regar ? (vwc < 20 ? 'correccion_urgente' : 'regar') : 'no_regar'
    }

    res.json({ ok: true, analisis })

  } catch (err) {
    console.error('[Claude] Error:', err)
    res.json({ ok: false, mensaje: err.message })
  }
})
app.listen(PORT, '0.0.0.0', () => { console.log('Servidor corriendo en http://0.0.0.0:' + PORT) })

// ── Endpoint análisis clima con Claude ────────────────────────────────────
app.post('/analizar-clima', upload.single('foto'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, mensaje: 'No se recibió imagen' })

  const fase  = req.body.fase  || 'floracion'
  const turno = req.body.turno || 'manana'

  try {
    const imgBuffer = await require('sharp')(req.file.buffer)
      .resize(1200, 1200, { fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer()
    const base64 = imgBuffer.toString('base64')

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          { type: 'text', text: `Esta es una foto de un termohigrómetro digital en un invernadero de cannabis.
Lee exactamente:
- Temperatura (°C) — el número seguido de °C o °
- Humedad relativa (%) — el número seguido de % o HR

Respondé SOLO en este JSON sin texto adicional:
{"temperatura": 0.0, "humedad": 0.0}` }
        ]
      }]
    })

    const texto = response.content[0].text.trim()
    let leido
    try { leido = JSON.parse(texto.replace(/```json|```/g,'').trim()) }
    catch { return res.json({ ok: false, mensaje: 'No pude leer el termohigrómetro', raw: texto }) }

    const temp = parseFloat(leido.temperatura)
    const hr   = parseFloat(leido.humedad)

    // Calcular VPD
    const svp = 0.6108 * Math.exp(17.27 * temp / (temp + 237.3))
    const avp = svp * (hr / 100)
    const vpd = parseFloat((svp - avp).toFixed(3))

    // Diagnostico agronomico especializado
    const rangos = { floracion:{min:1.0,max:1.5}, vegetativo:{min:0.8,max:1.2}, maduracion:{min:1.5,max:2.0} }
    const rango  = rangos[fase] || rangos.floracion
    const alertas=[], acciones=[]

    // VPD
    if(vpd<0.4){
      alertas.push('🔴 VPD crítico ('+vpd+' kPa) — Ambiente saturado. Las plantas no transpiran. Riesgo inmediato de hongos y pudrición radicular.')
      acciones.push('Abrir laterales al máximo','Ventiladores al 100%','NO foliar','Revisar drenaje del sustrato')
    } else if(vpd<rango.min){
      alertas.push('🟡 VPD bajo ('+vpd+' kPa) — Transpiración reducida. El ambiente está húmedo para esta fase. Las plantas absorben nutrientes lentamente.')
      acciones.push('Aumentar ventilación','Abrir laterales parcialmente','Evitar foliar')
    } else if(vpd<=rango.max){
      alertas.push('✅ VPD óptimo ('+vpd+' kPa) — Transpiración activa en rango. Las plantas absorben nutrientes correctamente. Sin acción requerida.')
    } else if(vpd<=2.0){
      alertas.push('🟡 VPD alto ('+vpd+' kPa) — Las plantas transpiran más de lo que absorben. Riesgo de estrés hídrico y quema de puntas si se mantiene.')
      acciones.push('Mojar pasillos','Cerrar laterales si hay viento seco','Aumentar volumen próximo riego')
    } else {
      alertas.push('🔴 VPD crítico ('+vpd+' kPa) — Estrés hídrico severo. Fotosíntesis comprometida. Terpenos en riesgo. Actuar de inmediato.')
      acciones.push('Mojar pasillos urgente','Riego de emergencia si VWC < 20%','Malla sombra si hay sol directo','Cerrar laterales')
    }

    // Temperatura
    if(temp>38){
      alertas.push('🔴 Temperatura crítica ('+temp+'°C) — Daño celular irreversible posible. Enzimas comprometidas. Cogollos en riesgo.')
      acciones.push('Malla sombra URGENTE','Ventiladores al máximo','Abrir todos los laterales','Mojar techo si es posible')
    } else if(temp>35){
      alertas.push('🔴 Temperatura muy alta ('+temp+'°C) — Estrés térmico severo. Fotosíntesis reducida al mínimo. Terpenos volátiles.')
      acciones.push('Malla sombra','Ventiladores al máximo','Abrir laterales')
    } else if(temp>32){
      alertas.push('🟡 Temperatura alta ('+temp+'°C) — Estrés térmico activo. Si se mantiene más de 2hs puede afectar calidad de cogollos.')
      acciones.push('Abrir laterales','Activar ventiladores','Mojar pasillos')
    } else if(temp<15){
      alertas.push('🔴 Temperatura baja ('+temp+'°C) — Metabolismo ralentizado. Riesgo de shock radicular en próximo riego.')
      acciones.push('Cerrar laterales','Revisar calefacción','No regar hasta que supere 18°C')
    } else if(temp<18){
      alertas.push('🟡 Temperatura baja ('+temp+'°C) — Crecimiento lento. Absorción de nutrientes reducida.')
      acciones.push('Cerrar laterales nocturnos','Monitorear cada 2 horas')
    }

    // Humedad relativa
    if(hr>75){
      alertas.push('🔴 HR muy alta ('+hr+'%) — Riesgo de Botrytis activo. En floración avanzada cualquier condensación en cogollos es crítica.')
      acciones.push('NO foliar bajo ningún concepto','Ventilación nocturna obligatoria','Revisar cogollos densos','Defoliar si hay zonas sin circulación de aire')
    } else if(hr>65 && fase==='floracion'){
      alertas.push('🟡 HR elevada para floración ('+hr+'%) — Zona de riesgo. Los cogollos acumulan humedad interna.')
      acciones.push('Aumentar ventilación','NO foliar','Revisar cogollos cada 2 días')
    } else if(hr>70){
      alertas.push('🟡 HR elevada ('+hr+'%) — Ambiente húmedo. Ventilación insuficiente.')
      acciones.push('Aumentar ventilación','Evitar foliar')
    } else if(hr<35){
      alertas.push('🟡 HR baja ('+hr+'%) — Ambiente muy seco. Riesgo de quema de puntas y estrés por transpiración excesiva.')
      acciones.push('Mojar pasillos','Revisar VPD para ajustar ventilación')
    } else if(hr<25){
      alertas.push('🔴 HR crítica ('+hr+'%) — Desecación activa. Las plantas pierden agua más rápido de lo que absorben.')
      acciones.push('Mojar pasillos urgente','Cerrar laterales','Aumentar frecuencia de riego')
    }

    res.json({ ok: true, temp, hr, vpd, diagnostico: { alertas, acciones } })

  } catch(err) {
    console.error('[Clima]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})

// ── Endpoint análisis visual con Claude ───────────────────────────────────
app.post('/analizar-visual', upload.array('fotos', 4), async (req, res) => {
  if (!req.files || !req.files.length) return res.json({ ok: false, mensaje: 'No se recibieron fotos' })

  const fase = req.body.fase || 'floracion'
  const obs  = req.body.observacion || ''

  try {
    // Preparar imágenes
    const imagenes = await Promise.all(req.files.map(async file => {
      const buf = await require('sharp')(file.buffer)
        .resize(800, 800, { fit: 'inside' })
        .jpeg({ quality: 75 })
        .toBuffer()
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } }
    }))

    const content = [
      ...imagenes,
      {
        type: 'text',
        text: `Sos un agrónomo especializado en cannabis medicinal en invernadero.
Analizá estas ${imagenes.length} foto(s) de plantas en fase: ${fase}.
${obs ? 'Nota del operario: ' + obs : ''}

Evaluá y respondé SOLO en este JSON sin texto adicional:
{
  "estado_general": "excelente|bueno|regular|malo|critico",
  "vigor": "alto|normal|bajo",
  "color": "descripcion breve del color de hojas",
  "fenologia": "descripcion del estado fenologico observado",
  "carencias": ["lista de carencias probables o vacio"],
  "excesos": ["lista de excesos o toxicidades probables o vacio"],
  "plagas": ["signos de plaga o enfermedad o vacio"],
  "estres": ["tipos de estres observados o vacio"],
  "acciones": ["lista de acciones concretas recomendadas"],
  "resumen": "texto breve de 2-3 lineas con el diagnostico general"
}`
      }
    ]

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content }]
    })

    const texto = response.content[0].text.trim()
    let diagnostico
    try {
      diagnostico = JSON.parse(texto.replace(/```json|```/g, '').trim())
    } catch {
      return res.json({ ok: false, mensaje: 'Error parseando diagnóstico', raw: texto })
    }

    res.json({ ok: true, diagnostico })

  } catch(err) {
    console.error('[Visual IA]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})

// ── Endpoint análisis visual con Claude ───────────────────────────────────
app.post('/analizar-visual', upload.array('fotos', 4), async (req, res) => {
  if (!req.files || !req.files.length) return res.json({ ok: false, mensaje: 'No se recibieron fotos' })

  const fase = req.body.fase || 'floracion'
  const obs  = req.body.observacion || ''

  try {
    // Preparar imágenes
    const imagenes = await Promise.all(req.files.map(async file => {
      const buf = await require('sharp')(file.buffer)
        .resize(800, 800, { fit: 'inside' })
        .jpeg({ quality: 75 })
        .toBuffer()
      return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } }
    }))

    const content = [
      ...imagenes,
      {
        type: 'text',
        text: `Sos un agrónomo especializado en cannabis medicinal en invernadero.
Analizá estas ${imagenes.length} foto(s) de plantas en fase: ${fase}.
${obs ? 'Nota del operario: ' + obs : ''}

Evaluá y respondé SOLO en este JSON sin texto adicional:
{
  "estado_general": "excelente|bueno|regular|malo|critico",
  "vigor": "alto|normal|bajo",
  "color": "descripcion breve del color de hojas",
  "fenologia": "descripcion del estado fenologico observado",
  "carencias": ["lista de carencias probables o vacio"],
  "excesos": ["lista de excesos o toxicidades probables o vacio"],
  "plagas": ["signos de plaga o enfermedad o vacio"],
  "estres": ["tipos de estres observados o vacio"],
  "acciones": ["lista de acciones concretas recomendadas"],
  "resumen": "texto breve de 2-3 lineas con el diagnostico general"
}`
      }
    ]

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content }]
    })

    const texto = response.content[0].text.trim()
    let diagnostico
    try {
      diagnostico = JSON.parse(texto.replace(/```json|```/g, '').trim())
    } catch {
      return res.json({ ok: false, mensaje: 'Error parseando diagnóstico', raw: texto })
    }

    res.json({ ok: true, diagnostico })

  } catch(err) {
    console.error('[Visual IA]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})

// ── Endpoint Smartlife / Tuya sensor ─────────────────────────────────────────
const crypto = require('crypto')

const TUYA_CLIENT_ID     = 'cpffcwyffdgt5a5wtng7'
const TUYA_CLIENT_SECRET = '76dfd300403b4683bb2a115e1488c3ef'
const TUYA_BASE_URL      = 'https://openapi.tuyaus.com'

let tuyaToken = null
let tuyaTokenExpiry = 0

function tuyaSign(secret, str) {
  return crypto.createHmac('sha256', secret).update(str).digest('hex').toUpperCase()
}

function tuyaBuildSignStr(clientId, accessToken, t, nonce, method, path, body) {
  const bodyHash = crypto.createHash('sha256').update(body || '').digest('hex')
  const strToSign = [method, bodyHash, '', path].join('\n')
  return clientId + accessToken + t + nonce + strToSign
}

async function getTuyaToken() {
  if (tuyaToken && Date.now() < tuyaTokenExpiry) return tuyaToken
  const t     = Date.now().toString()
  const nonce = ''
  const path  = '/v1.0/token?grant_type=1'
  const signStr = tuyaBuildSignStr(TUYA_CLIENT_ID, '', t, nonce, 'GET', path, '')
  const sign    = tuyaSign(TUYA_CLIENT_SECRET, signStr)
  const r = await fetch(TUYA_BASE_URL + path, {
    headers: { 'client_id': TUYA_CLIENT_ID, 'sign': sign, 'sign_method': 'HMAC-SHA256', 't': t, 'nonce': nonce, 'Content-Type': 'application/json' }
  })
  const data = await r.json()
  if (!data.success) throw new Error('Tuya auth error: ' + JSON.stringify(data))
  tuyaToken       = data.result.access_token
  tuyaTokenExpiry = Date.now() + (data.result.expire_time - 60) * 1000
  return tuyaToken
}

async function getTuyaDeviceStatus(deviceId) {
  const token = await getTuyaToken()
  const t     = Date.now().toString()
  const nonce = ''
  const path  = '/v1.0/devices/' + deviceId + '/status'
  const signStr = tuyaBuildSignStr(TUYA_CLIENT_ID, token, t, nonce, 'GET', path, '')
  const sign    = tuyaSign(TUYA_CLIENT_SECRET, signStr)
  const r = await fetch(TUYA_BASE_URL + path, {
    headers: { 'client_id': TUYA_CLIENT_ID, 'access_token': token, 'sign': sign, 'sign_method': 'HMAC-SHA256', 't': t, 'nonce': nonce, 'Content-Type': 'application/json' }
  })
  return r.json()
}

app.get('/smartlife-sensor', async (req, res) => {
  const deviceId = req.query.device_id || 'eb65b1c57e5cdf703ejvmj'
  try {
    const data = await getTuyaDeviceStatus(deviceId)
    if (!data.success) return res.json({ ok: false, error: data.msg || 'Error Tuya API', raw: data })

    const status = data.result
    const temp = status.find(s => s.code === 'va_temperature')?.value
    const hr   = status.find(s => s.code === 'va_humidity')?.value

    if (temp == null || hr == null) {
      return res.json({ ok: false, error: 'Sensores no encontrados en el dispositivo', raw: status })
    }

    const tempC = temp / 10
    const hrPct = hr / 10
    const svp   = 0.6108 * Math.exp(17.27 * tempC / (tempC + 237.3))
    const avp   = svp * (hrPct / 100)
    const vpd   = parseFloat((svp - avp).toFixed(3))

    res.json({ ok: true, temperatura: tempC, humedad: hrPct, vpd })
  } catch(err) {
    console.error('[Tuya]', err)
    res.json({ ok: false, error: err.message })
  }
})
