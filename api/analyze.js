export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, fields } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'API key no configurada' });

  try {
    const { lot, year, make, model, vin, titleType, auction, miles, milesStatus,
            damages, dashLights, dashCustom, observations, offerMin, offerMax, reportLink } = fields;

    const damageList = Array.isArray(damages) && damages.length > 0 ? damages : [];
    const damageText = damageList.length > 0 ? damageList.join(', ') : 'No especificado';

    const lightsMap = {
      'none': '',
      'check-engine': 'Check engine encendido — podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Luz de airbag/SRS encendida — posible detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Luz de transmisión encendida — posible falla en la caja automática.',
      'abs': 'Luz de ABS encendida — posible falla en el sistema de frenos antibloqueo.',
      'multiple': 'Múltiples luces del tablero encendidas — puede indicar fallas mecánicas o electrónicas.',
      'custom': dashCustom ? `${dashCustom} encendido — podría indicar algún tipo de falla mecánica o electrónica.` : ''
    };

    const lightsText = lightsMap[dashLights] || '';
    const isTitleClean = titleType === 'Clean';

    const hasHail = damageList.includes('Granizo');
    const otherRiskDamages = ['Inundación/Agua', 'Vandalismo', 'Colisión frontal', 'Colisión trasera', 'Colisión lateral', 'Volcado', 'Fuego'];
    const hasOtherRisk = damageList.some(d => otherRiskDamages.includes(d));

    let salvageWarning = '';

    if (isTitleClean) {
      if (hasHail && !hasOtherRisk) {
        // Solo granizo
        salvageWarning = `Daño por granizo suele recibir automáticamente un título salvage al momento de registrarse. Sin embargo, en Texas normalmente conserva un título clean. Aun así, recomendamos contactar al DMV para confirmar si, al momento de registrar el vehículo, mantendría el título clean o si podría cambiar a salvage.`;
      } else if (hasHail && hasOtherRisk) {
        // Granizo + otros daños
        salvageWarning = `Dado que presenta daño por granizo y ${damageList.filter(d => otherRiskDamages.includes(d)).join(', ')}, existe una alta probabilidad de que el título cambie a salvage al momento de registrarse, dependiendo del estado. En Texas el granizo normalmente conserva título clean, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV para confirmarlo antes de adquirirlo.`;
      } else if (hasOtherRisk) {
        // Otros daños sin granizo
        salvageWarning = `Dado que presenta daño por ${damageText}, existe la posibilidad de que al momento de registrar el vehículo el título cambie a salvage dependiendo del estado donde sea registrado. Recomendamos contactar al DMV local para confirmar esto antes de adquirirlo.`;
      }
    }

    const prompt = `Eres un broker experto de subastas de vehículos salvage (Copart, IAAI, Manheim). Redacta un análisis profesional en español para enviar por WhatsApp a un cliente. Debe ser CONCISO. Texto plano, sin markdown, sin asteriscos, sin guiones al inicio, sin emojis.

Usa EXACTAMENTE esta estructura respetando los saltos de línea. NO modifiques ni parafrasees el texto entre corchetes que diga INSERTAR TAL CUAL, cópialo exactamente:

${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}
[2-3 oraciones: explica el tipo de título "${titleType}" en ${auction}, los daños "${damageText}", millas ${miles} (${milesStatus}), y estado general. Todo fluido en un párrafo.]
${salvageWarning ? `INSERTAR TAL CUAL: ${salvageWarning}` : ''}
${lightsText ? `[1 oración sobre: ${lightsText}]` : ''}
${observations ? `[Mejora y redacta profesionalmente esto que observó el broker: ${observations}]` : ''}

Ofertaría entre $${offerMin} a $${offerMax}

VIN: ${vin}
Solicite su REPORTE aquí:
${reportLink}

Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.
CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data?.error?.message || 'Error de Groq' });

    const text = data?.choices?.[0]?.message?.content || '';
    return res.status(200).json({ result: text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
