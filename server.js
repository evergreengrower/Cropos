require('dotenv').config()

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

Luego, basándote en estos protocolos reales del cultivo Carmelo:

FASE ACTUAL: ${fase}
TARGET PRE-RIEGO VWC: ${target.preRiego}%
TARGET POST-RIEGO VWC: ${target.postRiego}%

PROTOCOLO DE CORRECCIÓN (${fase}):
- Post-riego objetivo: ${target.postRiego}%
- Si VWC actual >= target pre-riego: NO REGAR
- Si VWC < pre-riego: calcular volumen de corrección

TABLA DE CORRECCIÓN GENERATIVA (floración):
27% → no tocar si promedio estable
26% → +400 ml por planta
25% → +600 ml por planta
24% → +800 ml por planta
22-23% → +1000 ml por planta
< 22% → +1200 ml por planta

TABLA DE CORRECCIÓN VEGETATIVA AVANZADA:
>= 27% → NO REGAR
26% → 1500 ml
24-25% → 1500 ml
22-23% → +800 ml extra
20-21% → +1000 ml extra
< 18% → +1500 ml extra

Respondé SOLO en este formato JSON exacto, sin texto adicional:
{
  "lecturas": {
    "ec_promedio": 0.0,
    "vwc_promedio": 0.0,
    "temp_promedio": 0.0,
    "cantidad_lecturas": 0
  },
  "diagnostico": {
    "estado_vwc": "ok|bajo|critico",
    "diferencia_target": 0.0,
    "accion": "no_regar|regar|correccion_urgente"
  },
  "recomendacion": {
    "regar": true,
    "volumen_ml_por_planta": 0,
    "motivo": "texto explicativo breve"
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

    // Diagnóstico
    const rangos = { floracion:{min:1.0,max:1.5}, vegetativo:{min:0.8,max:1.2}, maduracion:{min:1.5,max:2.0} }
    const rango  = rangos[fase] || rangos.floracion
    const alertas=[], acciones=[]

    if(vpd<0.4){alertas.push('🔴 VPD muy bajo — riesgo hongos');acciones.push('Abrir laterales','NO foliar')}
    else if(vpd<rango.min){alertas.push('🟡 VPD bajo — ambiente húmedo');acciones.push('Ventilación moderada')}
    else if(vpd<=rango.max){alertas.push('🟢 VPD óptimo')}
    else if(vpd<=2.0){alertas.push('🟡 VPD alto — estrés leve');acciones.push('Mojar pasillos')}
    else{alertas.push('🔴 VPD crítico — estrés severo');acciones.push('Mojar pasillos urgente','Revisar riego')}

    if(temp>38){alertas.push('🔴 Temperatura crítica');acciones.push('Malla sombra URGENTE','Ventiladores max')}
    else if(temp>32){alertas.push('🟡 Temperatura alta');acciones.push('Abrir laterales','Ventiladores')}
    else if(temp<15){alertas.push('🔴 Temperatura baja');acciones.push('Cerrar laterales')}

    if(hr>75){alertas.push('🔴 HR muy alta — riesgo Botrytis');acciones.push('NO foliar','Ventilación máxima')}
    else if(hr>65){alertas.push('🟡 HR elevada');acciones.push('Aumentar ventilación')}
    else if(hr<35){alertas.push('🟡 HR baja');acciones.push('Mojar pasillos')}

    res.json({ ok: true, temp, hr, vpd, diagnostico: { alertas, acciones } })

  } catch(err) {
    console.error('[Clima]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})
