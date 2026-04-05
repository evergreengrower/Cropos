# BITÁCORA VISUAL IA — Documento de Arquitectura
**Proyecto:** Evergreen AI / CropOS
**Módulo:** Bitácora Visual IA
**Versión:** 1.0
**Fecha:** Abril 2026

---

## A) RESUMEN EJECUTIVO

La **Bitácora Visual IA** es el sistema de observación agronómica trazable de CropOS. Transforma cada foto, video o nota de campo en una **Unidad de Observación Agronómica (UOA)** estructurada, fechada, geolocalizada dentro del cultivo, enriquecida con variables técnicas y analizada por IA en contexto agronómico real.

**Diferencial clave:** No es una galería. Es un historial clínico de planta con inteligencia contextual.

**Usuarios objetivo:**
- Operarios de campo → carga rápida mobile
- Técnicos agronómicos → análisis, validación y seguimiento
- Dirección → tablero ejecutivo, trazabilidad y reportes

**Valor entregado:**
- Trazabilidad legal y técnica del cultivo
- Detección temprana de problemas
- Reducción de pérdidas por diagnóstico tardío
- Base de datos para entrenamiento de modelos IA propios
- Historial transferible entre cultivos y temporadas

---

## B) ARQUITECTURA FUNCIONAL

```
BITÁCORA VISUAL IA
│
├── CAPA DE CAPTURA
│   ├── Carga rápida (mobile-first)
│   ├── Foto / Video / Audio / Texto
│   ├── Selección lote > sector > sub-sector
│   ├── Tipo de evento
│   └── Variables agronómicas opcionales
│
├── CAPA DE ALMACENAMIENTO
│   ├── Supabase Storage (media)
│   ├── Supabase DB (metadatos + métricas)
│   └── LocalStorage (cache offline)
│
├── CAPA DE ANÁLISIS IA
│   ├── Pre-procesamiento de imagen
│   ├── Consulta a modelo visión (GPT-4V / Claude Vision)
│   ├── Enriquecimiento con contexto DNA del lote
│   ├── Respuesta estructurada JSON
│   └── Score de confianza
│
├── CAPA DE VALIDACIÓN HUMANA
│   ├── Confirmación / descarte de hipótesis
│   ├── Diagnóstico final del técnico
│   ├── Acción ejecutada
│   └── Cierre del evento
│
└── CAPA DE VISUALIZACIÓN
    ├── Vista Carga Rápida (operarios)
    ├── Vista Timeline (técnicos)
    └── Vista Tablero IA (dirección)
```

---

## C) ESQUEMA DE BASE DE DATOS

### Tabla: `visual_records` (registro central)

```sql
CREATE TABLE visual_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  fecha_evento    TIMESTAMPTZ NOT NULL,

  -- Ubicación en el cultivo
  lote_id         UUID REFERENCES lotes(id),
  sector          TEXT,
  sub_sector      TEXT,           -- cama / hilera / mesa / sala / bloque

  -- Contexto agronómico
  genetica        TEXT,
  fase_cultivo    TEXT,           -- vegetativo / floración / etc.
  dia_cultivo     INTEGER,

  -- Clasificación del evento
  tipo_evento     TEXT NOT NULL,  -- ver lista de tipos
  descripcion     TEXT,
  severidad       TEXT,           -- baja / media / alta / crítica
  estado          TEXT DEFAULT 'abierto', -- abierto / en_seguimiento / resuelto / cerrado

  -- Usuario
  usuario_id      TEXT,
  usuario_nombre  TEXT,

  -- Flags
  requiere_seguimiento  BOOLEAN DEFAULT FALSE,
  escalado_tecnico      BOOLEAN DEFAULT FALSE,
  tiene_analisis_ia     BOOLEAN DEFAULT FALSE,
  validado              BOOLEAN DEFAULT FALSE,

  -- Timestamps de cierre
  fecha_resolucion TIMESTAMPTZ,

  CONSTRAINT severidad_check CHECK (severidad IN ('baja','media','alta','critica')),
  CONSTRAINT estado_check CHECK (estado IN ('abierto','en_seguimiento','resuelto','cerrado'))
);
```

### Tabla: `media_files` (archivos multimedia)

```sql
CREATE TABLE media_files (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       UUID REFERENCES visual_records(id) ON DELETE CASCADE,
  tipo            TEXT NOT NULL,   -- foto / video / audio / documento
  url             TEXT NOT NULL,   -- URL en Supabase Storage
  thumbnail_url   TEXT,
  nombre_archivo  TEXT,
  tamaño_bytes    INTEGER,
  duracion_seg    INTEGER,         -- para audio/video
  orden           INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### Tabla: `agronomic_metrics` (variables del momento)

```sql
CREATE TABLE agronomic_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       UUID REFERENCES visual_records(id) ON DELETE CASCADE,

  -- Clima / ambiente
  temperatura_amb NUMERIC(5,2),
  humedad_rel     NUMERIC(5,2),
  vpd             NUMERIC(5,3),
  co2_ppm         INTEGER,
  ppfd            INTEGER,
  dli              NUMERIC(6,2),

  -- Suelo / sustrato
  vwc             NUMERIC(5,2),   -- % humedad sustrato
  ec_sustrato     NUMERIC(5,3),
  temperatura_sus NUMERIC(5,2),

  -- Solución de riego
  ec_solucion     NUMERIC(5,3),
  ph_solucion     NUMERIC(4,2),

  -- Riego ejecutado
  hora_ultimo_riego TIMESTAMPTZ,
  volumen_aplicado  NUMERIC(8,2), -- litros
  pulsos_riego      INTEGER,
  porcentaje_drenaje NUMERIC(5,2),

  -- Observaciones operativas
  notas_operativas TEXT,

  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### Tabla: `ai_analyses` (análisis IA)

```sql
CREATE TABLE ai_analyses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       UUID REFERENCES visual_records(id) ON DELETE CASCADE,
  modelo_ia       TEXT,            -- gpt-4v / claude-3 / etc.
  version_modelo  TEXT,

  -- Resultado estructurado
  clasificacion   TEXT,
  severidad       TEXT,
  confianza       NUMERIC(4,3),   -- 0.000 a 1.000
  hipotesis       JSONB,          -- array de hipótesis con probabilidades
  variables_faltantes JSONB,      -- array de variables no disponibles
  sugerencias     JSONB,          -- array de sugerencias técnicas
  prioridad       TEXT,           -- monitorear / revisar_en_dia / corregir_hoy / urgente
  requiere_tecnico BOOLEAN,
  evento_resuelto BOOLEAN,

  -- Contexto DNA usado
  contexto_dna    JSONB,          -- snapshot del DNA del lote al momento

  -- Respuesta raw
  respuesta_raw   TEXT,
  tokens_usados   INTEGER,

  created_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT prioridad_check CHECK (prioridad IN
    ('monitorear','revisar_en_dia','corregir_hoy','intervencion_urgente'))
);
```

### Tabla: `human_validations` (validación humana)

```sql
CREATE TABLE human_validations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       UUID REFERENCES visual_records(id) ON DELETE CASCADE,
  analysis_id     UUID REFERENCES ai_analyses(id),

  validacion      TEXT NOT NULL,  -- confirmado / parcial / descartado / pendiente / resuelto
  diagnostico_final TEXT,
  accion_ejecutada  TEXT,
  resultado_observado TEXT,
  fecha_cierre    TIMESTAMPTZ,

  validado_por    TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT validacion_check CHECK (validacion IN
    ('confirmado','parcialmente_confirmado','descartado','pendiente','resuelto'))
);
```

### Tabla: `event_followups` (seguimiento posterior)

```sql
CREATE TABLE event_followups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id       UUID REFERENCES visual_records(id) ON DELETE CASCADE,
  fecha           TIMESTAMPTZ NOT NULL,
  nota            TEXT,
  nuevo_estado    TEXT,
  media_url       TEXT,           -- foto de seguimiento
  usuario         TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

### Relaciones entre tablas

```
lotes ──────────────────────────────┐
                                    │
visual_records ←── (lote_id) ───────┘
       │
       ├──→ media_files         (1 record → N archivos)
       ├──→ agronomic_metrics   (1 record → 1 set métricas)
       ├──→ ai_analyses         (1 record → N análisis IA)
       │         └──→ human_validations (1 análisis → 1 validación)
       └──→ event_followups     (1 record → N seguimientos)
```

---

## D) FLUJO DE USUARIO

### Flujo Operario (campo)
```
1. Abre app en móvil
2. Toca "+" → Vista Carga Rápida
3. Saca / selecciona foto o video
4. Selecciona Lote → Sector → Sub-sector
5. Elige tipo de evento (lista corta de íconos)
6. Escribe nota opcional o graba audio
7. Completa variables si tiene sensor a mano
8. Toca "REGISTRAR" → guarda y genera análisis IA
9. Ve resultado IA brevemente
10. Cierra y sigue con su trabajo
```

### Flujo Técnico (análisis)
```
1. Entra a Vista Timeline del lote
2. Filtra por fecha / severidad / tipo de evento
3. Abre evento específico → ve detalle completo
4. Revisa fotos, métricas y análisis IA
5. Valida hipótesis IA (confirmar / descartar)
6. Escribe diagnóstico final
7. Registra acción ejecutada
8. Añade seguimiento posterior si necesita
9. Cierra o deja en seguimiento
```

### Flujo Dirección (tablero)
```
1. Abre Tablero IA
2. Ve KPIs: eventos activos, críticos, sin validar
3. Identifica focos por sector
4. Revisa recurrencias por genética
5. Exporta reporte semanal / mensual
```

---

## E) PROPUESTA VISUAL UI

### Vista 1 — Carga Rápida (mobile-first)
```
┌─────────────────────────────────┐
│ ← NUEVA OBSERVACIÓN   [Lote X] │
├─────────────────────────────────┤
│  [ 📷 FOTO ] [ 🎥 VIDEO ] [ 🎙] │
│                                 │
│  ┌─────────────────────────┐   │
│  │    [FOTO AQUÍ]          │   │
│  └─────────────────────────┘   │
├─────────────────────────────────┤
│ LOTE: [dropdown]               │
│ SECTOR: [dropdown]             │
│ TIPO: 💧Pre-riego  🌿Seguim.  │
│        🐛Plaga    🌡Estrés    │
├─────────────────────────────────┤
│ Nota:  [___________________]   │
├─────────────────────────────────┤
│     [      REGISTRAR      ]    │
└─────────────────────────────────┘
```

### Vista 2 — Timeline (técnicos)
```
┌──────────┬───────────────────────────────────────┐
│ FILTROS  │  TIMELINE — Lote Camellón Norte        │
│          │  ● 14 eventos · 2 críticos             │
│ Fecha:   ├───────────────────────────────────────┤
│ [rango]  │ 04/04 14:32  🔴 PLAGA — Sector B      │
│          │ [foto] Manchas blancas en hojas...     │
│ Lote:    │ IA: Posible Powdery Mildew · 87%       │
│ [select] │ ⚠ Sin validar  [Ver detalle]           │
│          ├───────────────────────────────────────┤
│ Tipo:    │ 04/04 09:15  🟡 SEGUIMIENTO — Sector A │
│ [multi]  │ [foto] VWC 28% post-riego mañana       │
│          │ IA: Rango óptimo · Mantener plan       │
│ Severidad│ ✅ Confirmado                          │
│ [multi]  ├───────────────────────────────────────┤
│          │ 03/04 17:45  🟠 ESTRÉS TÉRMICO         │
│ Estado:  │ [foto] Bordes quemados en hojas jóv.  │
│ [multi]  │ IA: Estrés por VPD alto · 72%         │
│          │ ⏳ En seguimiento                      │
└──────────┴───────────────────────────────────────┘
```

### Vista 3 — Tablero IA (dirección)
```
┌────────────┬────────────┬────────────┬────────────┐
│ 🔴 CRÍTICOS│ ⚠ SIN VAL. │ 📊 ACTIVOS │ ✅ RESUELTOS│
│     2      │     7      │    14      │    43      │
└────────────┴────────────┴────────────┴────────────┘
┌──────────────────────────┬─────────────────────────┐
│ FOCOS POR SECTOR          │ ALERTAS ACTIVAS          │
│ [mapa calor del lote]    │ 🔴 Plaga Sect.B → urgente │
│ Sector B ████████ alta   │ 🟠 Estrés Sect.A → hoy   │
│ Sector A ████░░░ media   │ 🟡 EC alto Sect.C → día  │
│ Sector C ██░░░░░ baja    │                          │
└──────────────────────────┴─────────────────────────┘
```

---

## F) JSON EJEMPLO — EVENTO CON ANÁLISIS IA

```json
{
  "event": {
    "id": "vr-2026-04-04-001",
    "fecha_evento": "2026-04-04T14:32:00-03:00",
    "usuario": "Martín R.",
    "lote": "Camellón Norte A",
    "sector": "Sector B",
    "sub_sector": "Hilera 3 - Cama 7",
    "genetica": "White Widow",
    "fase_cultivo": "floración",
    "dia_cultivo": 42,
    "tipo_evento": "anomalía_visual",
    "descripcion": "Manchas blancas en cara adaxial de hojas maduras. Aspecto harinoso. Detectado en 3 plantas.",
    "severidad_inicial": "alta"
  },
  "media": [
    {
      "tipo": "foto",
      "url": "storage/vr-2026-04-04-001/foto_01.jpg",
      "thumbnail_url": "storage/vr-2026-04-04-001/thumb_01.jpg"
    },
    {
      "tipo": "foto",
      "url": "storage/vr-2026-04-04-001/foto_02.jpg",
      "thumbnail_url": "storage/vr-2026-04-04-001/thumb_02.jpg"
    }
  ],
  "metricas_contextuales": {
    "temperatura_amb": 26.4,
    "humedad_rel": 74.2,
    "vpd": 0.87,
    "vwc": 31.5,
    "ec_sustrato": 2.1,
    "hora_ultimo_riego": "2026-04-04T09:15:00-03:00",
    "volumen_aplicado_l": 3.2,
    "ppfd": 680
  },
  "contexto_dna": {
    "variedad": "White Widow",
    "dominancia": "Híbrida",
    "sens_humedad": "Alta (propensa a hongos)",
    "sistema": "Indoor",
    "sustrato": "Coco",
    "modelo_agronomico": "generativo",
    "fase": "floración",
    "dias_fase": 14
  },
  "analisis_ia": {
    "modelo": "claude-3-5-sonnet",
    "version": "2024-10",
    "confianza": 0.87,
    "clasificacion_visual": "posible_patogeno",
    "severidad": "alta",
    "hipotesis": [
      {
        "nombre": "Oídio (Powdery Mildew)",
        "agente": "Golovinomyces cichoracearum",
        "probabilidad": 0.87,
        "razon": "Patrón visual harinoso en cara adaxial. VPD 0.87 kPa es favorable para desarrollo fúngico. HR 74% en floración D42 es factor de riesgo elevado. Variedad White Widow con sensibilidad alta registrada en DNA."
      },
      {
        "nombre": "Residuo mineral / quema de bordes",
        "probabilidad": 0.09,
        "razon": "EC sustrato 2.1 es levemente elevado pero no explica el patrón visual observado."
      },
      {
        "nombre": "Ácaros (Tetranychus urticae)",
        "probabilidad": 0.04,
        "razon": "Descartado por patrón de distribución y textura harinosa. Ácaros generan punteado, no polvo uniforme."
      }
    ],
    "variables_faltantes": [
      "Revisión de cara abaxial de hojas (envés) — necesario para confirmar presencia de micelio",
      "Temperatura de hoja medida",
      "Historial de HR últimas 72h"
    ],
    "sugerencias_tecnicas": [
      {
        "prioridad": 1,
        "accion": "Aislar las 3 plantas afectadas inmediatamente para evitar dispersión por esporas aéreas.",
        "tipo": "correctiva_urgente"
      },
      {
        "prioridad": 2,
        "accion": "Reducir HR del sector al 55-60% mediante deshumidificación o aumento de extracción. Extracción actual recomendada: +30% sobre nivel actual.",
        "tipo": "ambiental"
      },
      {
        "prioridad": 3,
        "accion": "Aplicar fungicida preventivo (azufre micronizado o bicarbonato de potasio) en plantas sanas del sector. NO aplicar en plantas con flores visibles.",
        "tipo": "fitosanitaria"
      },
      {
        "prioridad": 4,
        "accion": "Registrar seguimiento fotográfico en 48h para evaluar progresión o contención.",
        "tipo": "monitoreo"
      }
    ],
    "prioridad_atencion": "intervencion_urgente",
    "requiere_tecnico": true,
    "evento_resuelto": false,
    "recomendacion_seguimiento": "Revisar en 24-48h con fotos nuevas del mismo punto. Si hay extensión a plantas contiguas, tratar todo el sector.",
    "contexto_relevante": "White Widow tiene sensibilidad alta registrada a hongos en su DNA de lote. D42 de floración es ventana crítica: el daño en este punto puede afectar rendimiento final hasta un 15-30%."
  },
  "validacion_humana": {
    "validacion": "confirmado",
    "validado_por": "Ing. Pedro S.",
    "diagnostico_final": "Oídio confirmado por inspección visual directa. Micelio visible en envés.",
    "accion_ejecutada": "Aislamiento de 3 plantas. Aplicación bicarbonato de potasio 0.5% en plantas circundantes. Extracción aumentada a 1400 m3/h.",
    "resultado_observado": "A las 72h sin nuevos focos. Plantas tratadas en recuperación.",
    "fecha_cierre": "2026-04-07T10:00:00-03:00"
  }
}
```

---

## G) ROADMAP DE IMPLEMENTACIÓN

### FASE 1 — MVP Operativo (semanas 1-2)
**Objetivo:** Operarios pueden registrar observaciones y verlas cronológicamente.

- [ ] Vista carga rápida (foto + lote + tipo + nota)
- [ ] Almacenamiento en localStorage (offline-ready)
- [ ] Timeline cronológico básico
- [ ] Filtro por lote y tipo de evento
- [ ] Card de evento con miniatura y estado
- [ ] Integración en sidebar y dashboard

**Stack Fase 1:** HTML + CSS + JS + localStorage

---

### FASE 2 — Métricas y Detalle (semanas 3-4)
**Objetivo:** Cada evento tiene contexto agronómico completo.

- [ ] Formulario de métricas agronómicas al registrar
- [ ] Vista de detalle de evento expandida
- [ ] Carga de múltiples fotos por evento
- [ ] Carga de audio (nota de voz)
- [ ] Migración de localStorage → Supabase
- [ ] Subida de media a Supabase Storage
- [ ] Filtros avanzados (fecha, severidad, estado)

**Stack Fase 2:** + Supabase DB + Supabase Storage

---

### FASE 3 — IA Estructurada (semanas 5-7)
**Objetivo:** Cada evento recibe análisis IA con estructura completa.

- [ ] Integración con Claude Vision / GPT-4V
- [ ] Enriquecimiento con contexto DNA del lote
- [ ] Respuesta IA en JSON estructurado
- [ ] Panel de validación humana
- [ ] Score de confianza y severidad automática
- [ ] Historial de análisis por evento
- [ ] Notificaciones por severidad crítica

**Stack Fase 3:** + API de visión IA (Anthropic / OpenAI)

---

### FASE 4 — Tablero y Recurrencias (semanas 8-10)
**Objetivo:** Visión global e inteligencia sobre el cultivo.

- [ ] Tablero IA con KPIs y focos
- [ ] Detección de recurrencias (mismo problema > 2 veces)
- [ ] Mapa de calor por sector
- [ ] Comparativa temporal (antes/después)
- [ ] Exportación PDF de bitácora por lote
- [ ] Integración con módulo de riego y nutrición
- [ ] Tags para entrenamiento futuro de modelos

**Stack Fase 4:** + Chart.js / D3 + PDF export

---

### FASE 5 — Escalabilidad y Trazabilidad (mes 3+)
**Objetivo:** Sistema profesional para múltiples usuarios y cultivos.

- [ ] Autenticación multi-usuario con roles
- [ ] Notificaciones push para eventos críticos
- [ ] API pública para integración con sensores
- [ ] Dataset curado para fine-tuning de modelo propio
- [ ] Integración con ERP de cultivo
- [ ] Reportes regulatorios automáticos

---

## H) SUGERENCIAS DE STACK

### Frontend (sin cambios en server.js)
- **HTML + CSS + JS puro** — compatible con arquitectura actual
- **Chart.js** — para timeline y gráficos de recurrencia
- **FileReader API** — para previsualización de imágenes antes de subir

### Backend
- **Node.js + Express** — ya existente
- **Supabase** — ya integrado; agregar tablas y Storage bucket `bitacora`
- **Multer** — middleware para recibir archivos en endpoints Node

### IA / Visión
- **Anthropic Claude 3.5 Sonnet (claude-3-5-sonnet-20241022)** — mejor relación costo/precisión para análisis agronómico visual
- **Alternativa:** OpenAI GPT-4o con vision
- **Prompt system:** incluir siempre el JSON del DNA del lote como contexto

### Almacenamiento de Media
- **Supabase Storage** — bucket `bitacora-visual` con acceso público por URL
- **Política de acceso:** público para lectura, autenticado para escritura

### Endpoint sugerido en server.js
```javascript
// POST /api/bitacora/crear-registro
// POST /api/bitacora/subir-media
// GET  /api/bitacora/lote/:lote_id
// GET  /api/bitacora/evento/:record_id
// POST /api/bitacora/analisis-ia
// POST /api/bitacora/validar
```

### Modelo de prompt para análisis IA
```
Sistema: Eres un agrónomo experto en cultivos intensivos.
Analiza la imagen adjunta y responde EXCLUSIVAMENTE en JSON con la estructura definida.

Contexto del lote:
- Variedad: {variedad}
- Fase: {fase} (día {dia})
- Sustrato: {sustrato}
- Modelo agronómico: {modelo}
- VWC actual: {vwc}%
- HR: {hr}%
- VPD: {vpd} kPa
- EC solución: {ec}

Devuelve: clasificacion, severidad, confianza, hipotesis[],
variables_faltantes[], sugerencias[], prioridad, requiere_tecnico,
evento_resuelto, recomendacion_seguimiento
```

---

*Documento generado: Evergreen AI / CropOS — Arquitectura Bitácora Visual IA v1.0*
