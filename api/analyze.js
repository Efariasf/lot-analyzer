export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { imageBase64, mediaType, mode, fields } = req.body;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'API key no configurada' });

  try {
    let prompt = '';

    if (mode === 'extract') {
      prompt = `Eres experto en subastas de vehículos salvage (Copart, IAAI, Manheim). Analiza esta imagen y extrae todos los datos visibles. Responde SOLO con JSON válido, sin markdown, sin backticks:
{"lot":"","year":"","make":"","model":"","vin":"","title_type":"Clean","miles":"","miles_status":"Actuales","auction":"Copart","damage":"","dash_lights":"none","dash_lights_detail":"","initial_observations":""}

Valores posibles:
- title_type: Clean, Salvage, Rebuilt, Parts Only, Certificate of Destruction
- miles_status: Actuales, No actuales (TMU), Exentas
- auction: Copart, IAAI, Manheim
- dash_lights: none, check-engine, airbag, transmission, abs, multiple, custom`;

    } else if (mode === 'generate') {
      const { lot, year, make, model, vin, titleType, auction, miles, milesStatus,
              damage, dashLights, dashCustom, observations, offerMin, offerMax, reportLink } = fields;

      const lightsMap = {
        'none': '',
        'check-engine': 'Check engine encendido — podría indicar algún tipo de falla mecánica o electrónica.',
        'airbag': 'Luz de airbag/SRS encendida — posible detonación de airbags o falla en el sistema de seguridad.',
        'transmission': 'Luz de transmisión encendida — posible falla en la caja automática.',
        'abs': 'Luz de ABS encendida — posible falla en el sistema de frenos antibloqueo.',
        'multiple': 'Múltiples luces del tablero encendidas — puede indicar fallas mecánicas o electrónicas.',
        'custom': dashCustom ? `${dashCustom} encendido — podría indicar algún tipo de falla.` : ''
      };

      const lightsText = lightsMap[dashLights] || '';

      prompt = `Eres un broker experto de subastas de vehículos salvage. Redacta un análisis profesional en español para enviar por WhatsApp a un cliente. Debe ser CONCISO (máximo 5-6 oraciones en total antes de la oferta). Texto plano, sin markdown, sin asteriscos, sin guiones al inicio.

Usa exactamente esta estructura:

${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}
[2-3 oraciones máximo: título, daño, estado general. Todo junto, fluido.]
${lightsText ? `[1 oración sobre: ${lightsText}]` : ''}
${observations ? `[1 oración sobre: ${observations}]` : ''}

Ofertaría entre $${offerMin} a $${offerMax}

VIN: ${vin}
${reportLink ? `Solicite su REPORTE aquí:\n${reportLink}\n` : ''}
Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.
CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;
    }

    const body = {
      contents: [{
        parts: [
          ...(imageBase64 ? [{ inline_data: { mime_type: mediaType || 'image/jpeg', data: imageBase64 } }] : []),
          { text: prompt }
        ]
      }]
    };

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    const data = await geminiRes.json();
    if (!geminiRes.ok) return res.status(500).json({ error: data?.error?.message || 'Error de Gemini' });

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({ result: text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
