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
app.use(express.json({ limit: '50mb' }))

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

  res.json({ ok: true, mensaje: 'MediciÃ³n guardada correctamente' })
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
  if (!req.file) return res.json({ ok: false, mensaje: 'No se recibiÃ³ archivo' })
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

// â”€â”€ Endpoint anÃ¡lisis de foto BlueLab con Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const Anthropic = require('@anthropic-ai/sdk')
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

app.post('/analizar-foto', upload.single('foto'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, mensaje: 'No se recibiÃ³ imagen' })

  const loteId   = req.body.lote_id
  const loteNom  = req.body.lote || 'Sin lote'
  const fase     = req.body.fase || 'floracion'

  // Convertir imagen a base64
  const sharp = require("sharp"); const imgBuffer = await sharp(req.file.buffer).resize(1200, 1200, {fit:"inside"}).jpeg({quality:80}).toBuffer(); const base64 = imgBuffer.toString("base64"); const mime = "image/jpeg";

  // Targets de Carmelo segÃºn fase
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

AnalizÃ¡ esta imagen de la pantalla del sensor BlueLab Pulse y extraÃ© los valores de:
- EC (mS/cm)
- VWC o Humedad (%)
- Temperatura (Â°C)

Esta es la pantalla de historial de la app BlueLab Pulse. Muestra filas de mediciones. Cada fila tiene 3 columnas: COLUMNA IZQUIERDA = EC (numero con superindice EC), COLUMNA CENTRAL = VWC Humedad (numero con superindice % o asterisco), COLUMNA DERECHA = Temperatura (numero con superindice C). Lee cada fila de arriba hacia abajo. Extrae SOLO los numeros de la COLUMNA CENTRAL (VWC). Ignora la ultima fila si esta cortada. Suma todos los valores de VWC que pudiste leer completamente y divide por la cantidad de filas completas. Devuelve tambien cuantas filas leiste.

RespondÃ© SOLO en este formato JSON exacto, sin texto adicional:
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
        notas:       'Importado desde foto BlueLab Â· AnÃ¡lisis IA',
        fecha:       new Date().toISOString()
      }])
    }

    // LÃ³gica determinista de recomendaciÃ³n segÃºn fase
    const vwc = analisis.lecturas?.vwc_promedio || 0

    let regar = false
    let volumen = 0
    let motivo = ''

    if (fase === 'floracion') {
      if (vwc >= 27)      { regar = false; volumen = 0;   motivo = 'VWC '+vwc+'% â€” No regar (generativa)' }
      else if (vwc >= 25) { regar = true;  volumen = 400; motivo = 'VWC '+vwc+'% â€” Regar 400ml (generativa ~26%)' }
      else if (vwc >= 23) { regar = true;  volumen = 550; motivo = 'VWC '+vwc+'% â€” Regar 550ml (generativa ~24%)' }
      else if (vwc >= 21) { regar = true;  volumen = 700; motivo = 'VWC '+vwc+'% â€” Regar 700ml (generativa ~22%)' }
      else                { regar = true;  volumen = 800; motivo = 'VWC '+vwc+'% â€” Regar 800ml (generativa ~20%)' }
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
// â”€â”€ Endpoint diagnÃ³stico imagen desde BitÃ¡cora â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/diagnostico-imagen', async (req, res) => {
  const { imagen_b64, media_type, dna_contexto } = req.body
  if (!imagen_b64) return res.json({ ok: false, diagnostico: 'No se recibiÃ³ imagen' })

  const systemPrompt = `Sos un agrÃ³nomo especialista en cannabis medicinal y cultivos botÃ¡nicos. 
AnalizÃ¡s imÃ¡genes de cultivos y detectÃ¡s: deficiencias nutricionales, problemas de pH/EC, plagas, patÃ³genos, estrÃ©s hÃ­drico, estrÃ©s tÃ©rmico, problemas de VPD, y otros sÃ­ntomas visuales.
RespondÃ© en espaÃ±ol, de forma concisa y tÃ©cnica.
${dna_contexto ? 'Contexto del lote: ' + dna_contexto : ''}
Estructura tu respuesta asÃ­:
1. DIAGNÃ“STICO PRINCIPAL (1-2 lÃ­neas)
2. SÃNTOMAS OBSERVADOS (lista breve)
3. CAUSA PROBABLE
4. ACCIÃ“N RECOMENDADA`

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_b64 } },
          { type: 'text', text: 'AnalizÃ¡ esta imagen del cultivo y proporcionÃ¡ un diagnÃ³stico agronÃ³mico detallado.' }
        ]
      }]
    })
    const diagnostico = response.content[0].text
    res.json({ ok: true, diagnostico })
  } catch(err) {
    console.error('[DiagIA]', err)
    res.json({ ok: false, diagnostico: 'Error al procesar imagen: ' + err.message })
  }
})

// ── Endpoint diagnóstico imagen desde Bitácora ─────────────────────────
app.post('/api/diagnostico-imagen', async (req, res) => {
  console.log('[DiagIA] llamada recibida, keys:', Object.keys(req.body || {}))
  const { imagen_b64, media_type, dna_contexto } = req.body
  if (!imagen_b64) return res.json({ ok: false, diagnostico: 'No se recibió imagen' })
  const systemPrompt = `Sos un agrónomo especialista en cannabis medicinal. Analizás imágenes de cultivos y detectás deficiencias, plagas, patógenos y estrés. Respondé en español de forma técnica.${dna_contexto ? ' Contexto: ' + dna_contexto : ''} Estructura: 1. DIAGNÓSTICO PRINCIPAL 2. SÍNTOMAS OBSERVADOS 3. CAUSA PROBABLE 4. ACCIÓN RECOMENDADA`
  try {
    const response = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: media_type || 'image/jpeg', data: imagen_b64 } }, { type: 'text', text: 'Analizá esta imagen del cultivo.' }] }] })
    res.json({ ok: true, diagnostico: response.content[0].text })
  } catch(err) {
    console.error('[DiagIA] Error:', err.message)
    res.json({ ok: false, diagnostico: 'Error: ' + err.message })
  }
})

app.listen(PORT, '0.0.0.0', () => { console.log('Servidor corriendo en http://0.0.0.0:' + PORT) })

// â”€â”€ Endpoint anÃ¡lisis clima con Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/analizar-clima', upload.single('foto'), async (req, res) => {
  if (!req.file) return res.json({ ok: false, mensaje: 'No se recibiÃ³ imagen' })

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
          { type: 'text', text: `Esta es una foto de un termohigrÃ³metro digital en un invernadero de cannabis.
Lee exactamente:
- Temperatura (Â°C) â€” el nÃºmero seguido de Â°C o Â°
- Humedad relativa (%) â€” el nÃºmero seguido de % o HR

RespondÃ© SOLO en este JSON sin texto adicional:
{"temperatura": 0.0, "humedad": 0.0}` }
        ]
      }]
    })

    const texto = response.content[0].text.trim()
    let leido
    try { leido = JSON.parse(texto.replace(/```json|```/g,'').trim()) }
    catch { return res.json({ ok: false, mensaje: 'No pude leer el termohigrÃ³metro', raw: texto }) }

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
      alertas.push('ðŸ”´ VPD crÃ­tico ('+vpd+' kPa) â€” Ambiente saturado. Las plantas no transpiran. Riesgo inmediato de hongos y pudriciÃ³n radicular.')
      acciones.push('Abrir laterales al mÃ¡ximo','Ventiladores al 100%','NO foliar','Revisar drenaje del sustrato')
    } else if(vpd<rango.min){
      alertas.push('ðŸŸ¡ VPD bajo ('+vpd+' kPa) â€” TranspiraciÃ³n reducida. El ambiente estÃ¡ hÃºmedo para esta fase. Las plantas absorben nutrientes lentamente.')
      acciones.push('Aumentar ventilaciÃ³n','Abrir laterales parcialmente','Evitar foliar')
    } else if(vpd<=rango.max){
      alertas.push('âœ… VPD Ã³ptimo ('+vpd+' kPa) â€” TranspiraciÃ³n activa en rango. Las plantas absorben nutrientes correctamente. Sin acciÃ³n requerida.')
    } else if(vpd<=2.0){
      alertas.push('ðŸŸ¡ VPD alto ('+vpd+' kPa) â€” Las plantas transpiran mÃ¡s de lo que absorben. Riesgo de estrÃ©s hÃ­drico y quema de puntas si se mantiene.')
      acciones.push('Mojar pasillos','Cerrar laterales si hay viento seco','Aumentar volumen prÃ³ximo riego')
    } else {
      alertas.push('ðŸ”´ VPD crÃ­tico ('+vpd+' kPa) â€” EstrÃ©s hÃ­drico severo. FotosÃ­ntesis comprometida. Terpenos en riesgo. Actuar de inmediato.')
      acciones.push('Mojar pasillos urgente','Riego de emergencia si VWC < 20%','Malla sombra si hay sol directo','Cerrar laterales')
    }

    // Temperatura
    if(temp>38){
      alertas.push('ðŸ”´ Temperatura crÃ­tica ('+temp+'Â°C) â€” DaÃ±o celular irreversible posible. Enzimas comprometidas. Cogollos en riesgo.')
      acciones.push('Malla sombra URGENTE','Ventiladores al mÃ¡ximo','Abrir todos los laterales','Mojar techo si es posible')
    } else if(temp>35){
      alertas.push('ðŸ”´ Temperatura muy alta ('+temp+'Â°C) â€” EstrÃ©s tÃ©rmico severo. FotosÃ­ntesis reducida al mÃ­nimo. Terpenos volÃ¡tiles.')
      acciones.push('Malla sombra','Ventiladores al mÃ¡ximo','Abrir laterales')
    } else if(temp>32){
      alertas.push('ðŸŸ¡ Temperatura alta ('+temp+'Â°C) â€” EstrÃ©s tÃ©rmico activo. Si se mantiene mÃ¡s de 2hs puede afectar calidad de cogollos.')
      acciones.push('Abrir laterales','Activar ventiladores','Mojar pasillos')
    } else if(temp<15){
      alertas.push('ðŸ”´ Temperatura baja ('+temp+'Â°C) â€” Metabolismo ralentizado. Riesgo de shock radicular en prÃ³ximo riego.')
      acciones.push('Cerrar laterales','Revisar calefacciÃ³n','No regar hasta que supere 18Â°C')
    } else if(temp<18){
      alertas.push('ðŸŸ¡ Temperatura baja ('+temp+'Â°C) â€” Crecimiento lento. AbsorciÃ³n de nutrientes reducida.')
      acciones.push('Cerrar laterales nocturnos','Monitorear cada 2 horas')
    }

    // Humedad relativa
    if(hr>75){
      alertas.push('ðŸ”´ HR muy alta ('+hr+'%) â€” Riesgo de Botrytis activo. En floraciÃ³n avanzada cualquier condensaciÃ³n en cogollos es crÃ­tica.')
      acciones.push('NO foliar bajo ningÃºn concepto','VentilaciÃ³n nocturna obligatoria','Revisar cogollos densos','Defoliar si hay zonas sin circulaciÃ³n de aire')
    } else if(hr>65 && fase==='floracion'){
      alertas.push('ðŸŸ¡ HR elevada para floraciÃ³n ('+hr+'%) â€” Zona de riesgo. Los cogollos acumulan humedad interna.')
      acciones.push('Aumentar ventilaciÃ³n','NO foliar','Revisar cogollos cada 2 dÃ­as')
    } else if(hr>70){
      alertas.push('ðŸŸ¡ HR elevada ('+hr+'%) â€” Ambiente hÃºmedo. VentilaciÃ³n insuficiente.')
      acciones.push('Aumentar ventilaciÃ³n','Evitar foliar')
    } else if(hr<35){
      alertas.push('ðŸŸ¡ HR baja ('+hr+'%) â€” Ambiente muy seco. Riesgo de quema de puntas y estrÃ©s por transpiraciÃ³n excesiva.')
      acciones.push('Mojar pasillos','Revisar VPD para ajustar ventilaciÃ³n')
    } else if(hr<25){
      alertas.push('ðŸ”´ HR crÃ­tica ('+hr+'%) â€” DesecaciÃ³n activa. Las plantas pierden agua mÃ¡s rÃ¡pido de lo que absorben.')
      acciones.push('Mojar pasillos urgente','Cerrar laterales','Aumentar frecuencia de riego')
    }

    res.json({ ok: true, temp, hr, vpd, diagnostico: { alertas, acciones } })

  } catch(err) {
    console.error('[Clima]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})

// â”€â”€ Endpoint anÃ¡lisis visual con Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/analizar-visual', upload.array('fotos', 4), async (req, res) => {
  if (!req.files || !req.files.length) return res.json({ ok: false, mensaje: 'No se recibieron fotos' })

  const fase = req.body.fase || 'floracion'
  const obs  = req.body.observacion || ''

  try {
    // Preparar imÃ¡genes
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
        text: `Sos un agrÃ³nomo especializado en cannabis medicinal en invernadero.
AnalizÃ¡ estas ${imagenes.length} foto(s) de plantas en fase: ${fase}.
${obs ? 'Nota del operario: ' + obs : ''}

EvaluÃ¡ y respondÃ© SOLO en este JSON sin texto adicional:
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
      return res.json({ ok: false, mensaje: 'Error parseando diagnÃ³stico', raw: texto })
    }

    res.json({ ok: true, diagnostico })

  } catch(err) {
    console.error('[Visual IA]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})

// â”€â”€ Endpoint anÃ¡lisis visual con Claude â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/analizar-visual', upload.array('fotos', 4), async (req, res) => {
  if (!req.files || !req.files.length) return res.json({ ok: false, mensaje: 'No se recibieron fotos' })

  const fase = req.body.fase || 'floracion'
  const obs  = req.body.observacion || ''

  try {
    // Preparar imÃ¡genes
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
        text: `Sos un agrÃ³nomo especializado en cannabis medicinal en invernadero.
AnalizÃ¡ estas ${imagenes.length} foto(s) de plantas en fase: ${fase}.
${obs ? 'Nota del operario: ' + obs : ''}

EvaluÃ¡ y respondÃ© SOLO en este JSON sin texto adicional:
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
      return res.json({ ok: false, mensaje: 'Error parseando diagnÃ³stico', raw: texto })
    }

    res.json({ ok: true, diagnostico })

  } catch(err) {
    console.error('[Visual IA]', err)
    res.json({ ok: false, mensaje: err.message })
  }
})

// â”€â”€ Endpoint Smartlife / Tuya sensor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // Buscar por distintos cÃ³digos posibles
    const tempEntry = status.find(s => s.code === 'va_temperature' || s.code === 'temp_current' || s.code === 'temperature')
    const hrEntry   = status.find(s => s.code === 'va_humidity'    || s.code === 'humidity_value' || s.code === 'humidity')

    if (!tempEntry || !hrEntry) {
      return res.json({ ok: false, error: 'Sensores no encontrados', raw: status })
    }

    const tempRaw = tempEntry.value
    const hrRaw   = hrEntry.value

    // Detectar divisor automÃ¡ticamente
    // Si el valor raw es mayor a 100 asumimos que estÃ¡ en dÃ©cimas
    const tempC = tempRaw > 100 ? tempRaw / 10 : tempRaw
    const hrPct = hrRaw   > 100 ? hrRaw   / 10 : hrRaw

    const svp = 0.6108 * Math.exp(17.27 * tempC / (tempC + 237.3))
    const avp = svp * (hrPct / 100)
    const vpd = parseFloat((svp - avp).toFixed(3))

    res.json({ ok: true, temperatura: tempC, humedad: hrPct, vpd })
  } catch(err) {
    console.error('[Tuya]', err)
    res.json({ ok: false, error: err.message })
  }
})


