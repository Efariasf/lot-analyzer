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
            damages, dashLights, dashCustom, observations, offerMin, offerMax,
            buyNow, reservePrice } = fields;

    const REPORT_LINK = 'https://t.me/reporteexpressbot';

    const buyNowText = buyNow ? `\nTiene precio de compra inmediata (Buy Now) de $${buyNow}.` : '';
    const reserveText = reservePrice ? `\nTiene precio de reserva de $${reservePrice}.` : '';

    const damageList = Array.isArray(damages) && damages.length > 0 ? damages : [];
    const damageText = damageList.length > 0 ? damageList.join(', ') : 'No especificado';

    const lightsMap = {
      'none': '',
      'check-engine': 'Check engine encendido — podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Luz de airbag/SRS encendida — posible detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Luz de transmisión encendida — posible falla en la caja automática.',
      'abs': 'Luz de ABS encendida — posible falla en el sistema de frenos antibloqueo.',
      'battery': 'Luz de batería encendida — podría indicar falla en el alternador, batería o sistema eléctrico.',
      'oil': 'Luz de aceite encendida — podría indicar baja presión de aceite o falla en el sistema de lubricación.',
      'temperature': 'Luz de temperatura encendida — podría indicar sobrecalentamiento del motor.',
      'multiple': 'Múltiples luces del tablero encendidas — puede indicar fallas mecánicas o electrónicas.',
      'custom': dashCustom ? `${dashCustom} encendido — podría indicar algún tipo de falla mecánica o electrónica.` : ''
    };

    const lightsText = lightsMap[dashLights] || '';
    const isTitleClean = titleType === 'Clean';

    const hasHail = damageList.includes('Granizo');
    // Solo estos daños pueden causar cambio a salvage
    const salvageTriggers = ['Inundación/Agua', 'Vandalismo', 'Fuego'];
    const hasSalvageTrigger = damageList.some(d => salvageTriggers.includes(d));

    let salvageWarning = '';

    if (isTitleClean) {
      if (hasHail && !hasSalvageTrigger) {
        // Solo granizo
        salvageWarning = `Daño por granizo suele recibir automáticamente un título salvage al momento de registrarse. Sin embargo, en Texas normalmente conserva un título clean. Aun así, recomendamos contactar al DMV para confirmar si, al momento de registrar el vehículo, mantendría el título clean o si podría cambiar a salvage.`;
      } else if (hasHail && hasSalvageTrigger) {
        // Granizo + inundación/vandalismo/fuego
        const extra = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta daño por granizo y ${extra}, existe una alta probabilidad de que el título cambie a salvage al momento de registrarse, dependiendo del estado. En Texas el granizo normalmente conserva título clean, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV para confirmarlo antes de adquirirlo.`;
      } else if (hasSalvageTrigger) {
        // Inundación/vandalismo/fuego sin granizo
        salvageWarning = `Dado que presenta daño por ${damageText}, existe la posibilidad de que al momento de registrar el vehículo el título cambie a salvage dependiendo del estado donde sea registrado. Recomendamos contactar al DMV local para confirmar esto antes de adquirirlo.`;
      }
    }

    const prompt = `Eres un broker experto de subastas de vehículos salvage (Copart, IAAI, Manheim). Redacta un análisis profesional en español para enviar por WhatsApp a un cliente. Debe ser CONCISO. Texto plano, sin markdown, sin asteriscos, sin guiones al inicio, sin emojis.

Usa EXACTAMENTE esta estructura respetando los saltos de línea. NO modifiques ni parafrasees el texto marcado como INSERTAR TAL CUAL:

${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}
[2-3 oraciones: explica el tipo de título "${titleType}" en ${auction}, los daños "${damageText}", millas ${miles} (${milesStatus}), y estado general. Todo fluido en un párrafo.]
${salvageWarning ? `INSERTAR TAL CUAL: ${salvageWarning}` : ''}
${lightsText ? `[1 oración sobre: ${lightsText}]` : ''}
${observations ? `[Mejora y redacta profesionalmente esto que observó el broker: ${observations}]` : ''}

Ofertaría entre $${offerMin} a $${offerMax}
${buyNowText}${reserveText}

VIN: ${vin}
Solicite su REPORTE aquí:
${REPORT_LINK}

Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.
CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`      body: JSON.stringify({
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
