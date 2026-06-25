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
            damages, dashLights, dashCustom, observations, mechanicalStatus,
            offerMin, offerMax, buyNow, reservePrice, copartGo, externalLot, tituloAusente } = fields;

    const mechMap = {
      'no-enciende': 'El vehículo no enciende.',
      'enciende-no-rueda': 'Copart verificó que el motor enciende, sin embargo el vehículo no rueda, lo que podría indicar algún tipo de falla mecánica como transmisión u otro problema relacionado.',
      'enciende-rueda': 'Copart verificó que el motor enciende y la transmisión engrana.'
    };
    const mechText = mechMap[mechanicalStatus] || '';

    const tituloAusenteWarning = tituloAusente
      ? `Título "${titleType}" en Copart: no posee el título actualmente. Copart le da al vendedor 30 días hábiles para que sea enviado a la yarda; luego ellos deben enviárnoslo a FL.`
      : '';

    const milesStatusMap = {
      'Actuales': '',
      'No actuales (TMU)': 'Las millas aparecen como No Actuales (TMU — True Mileage Unknown), lo que significa que las millas reales son desconocidas. Esto ocurre cuando el odómetro pudo haber sido alterado o el vehículo sufrió un daño importante que impide comprobar el millaje real. Considérelo al momento de evaluar el vehículo.',
      'Exentas': 'Las millas aparecen como Exentas (Exempt), lo que significa que legalmente no se puede certificar que el número del tablero sea el real. Esto ocurre generalmente porque al momento del accidente el vehículo quedó sin batería, el tablero se dañó, o la aseguradora no pudo encenderlo para verificar. No necesariamente implica fraude — muchas veces el número del tablero es cercano al real, pero por protección legal los papeles se procesan como Exento. Le recomendamos revisar el Carfax para ver las millas registradas en el último servicio antes del accidente.'
    };
    const milesWarning = milesStatusMap[milesStatus] || '';

    const copartGoWarning = copartGo
      ? 'Este vehículo está listado como CopartGO, lo que significa que fue publicado directamente por el vendedor (negocio o particular) usando la app móvil de Copart. El informe de condición lo completó el propio vendedor con respuestas de Sí/No y NO representa la opinión de Copart, quien no inspeccionó el vehículo ni se hace responsable de la exactitud del informe.'
      : '';

    const externalLotWarning = externalLot
      ? 'Este es un Lote Externo, lo que significa que el vehículo NO se encuentra físicamente en una ubicación de Copart. Está en una ubicación designada para previsualizar y retirar indicada en el lote. Tome esto en cuenta para la logística de retiro.'
      : '';

    const isDestruction = titleType === 'Certificate of Destruction / Junk';
    const destructionWarning = isDestruction
      ? 'Este vehículo posee un título Certificate of Destruction (Junk), lo que significa que JAMÁS podrá circular legalmente en las carreteras de Estados Unidos. Solo puede ser utilizado para chatarra o venta de piezas.'
      : '';

    const REPORT_LINK = 'https://t.me/reporteexpressbot';
    const buyNowText = buyNow ? `\nEl vehículo tiene un precio de compra inmediata (Buy Now) de $${buyNow}, ese es el precio mínimo que acepta el vendedor para cerrar la venta de inmediato.` : '';
    const reserveText = reservePrice ? `\nTiene precio de reserva de $${reservePrice}.` : '';

    const damageList = Array.isArray(damages) && damages.length > 0 ? damages : [];
    // Limpiar prefijos redundantes para el texto (ej: "Daño trasero" → "trasero")
    const damageTextClean = damageList.map(d => d.replace(/^Daño\s+/i, '')).join(', ');
    const damageText = damageList.join(', ');

    const lightsMap = {
      'check-engine': 'Check engine encendido — podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Luz de airbag/SRS encendida — podría indicar detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Luz de transmisión encendida — podría indicar algún tipo de falla en la caja automática.',
      'abs': 'Luz de ABS encendida — podría indicar algún tipo de falla en el sistema de frenos antibloqueo.',
      'battery': 'Luz de batería encendida — podría indicar falla en el alternador, batería o sistema eléctrico.',
      'oil': 'Luz de aceite encendida — podría indicar baja presión de aceite o falla en el sistema de lubricación.',
      'temperature': 'Luz de temperatura encendida — podría indicar sobrecalentamiento del motor.',
      'multiple': 'Múltiples luces del tablero encendidas — esto podría indicar algún tipo de daño eléctrico o falla mecánica en el vehículo.',
      'custom': dashCustom ? `${dashCustom} encendido — podría indicar algún tipo de falla mecánica o electrónica.` : ''
    };

    // dashLights puede ser array (múltiple selección) o string legacy
    const lightsArray = Array.isArray(dashLights) ? dashLights : (dashLights && dashLights !== 'none' ? [dashLights] : []);
    const lightsText = lightsArray.map(l => lightsMap[l] || '').filter(Boolean).join(' ');
    const noLightsText = lightsArray.length === 0 ? 'No presenta luces de motor ni airbag encendidas en el tablero.' : '';

    const isTitleClean = titleType === 'Clean';
    const hasHail = damageList.includes('Granizo');
    const salvageTriggers = ['Inundación/Agua', 'Vandalismo', 'Fuego'];
    const hasSalvageTrigger = damageList.some(d => salvageTriggers.includes(d));

    let salvageWarning = '';
    if (isTitleClean) {
      if (hasHail && !hasSalvageTrigger) {
        salvageWarning = `Daño por granizo suele recibir automáticamente un título salvage al momento de registrarse. Sin embargo, en Texas normalmente conserva un título clean. Aun así, recomendamos contactar al DMV para confirmar si, al momento de registrar el vehículo, mantendría el título clean o si podría cambiar a salvage.`;
      } else if (hasHail && hasSalvageTrigger) {
        const extra = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta granizo y ${extra}, existe una alta probabilidad de que el título cambie a salvage al momento de registrarse dependiendo del estado. En Texas el granizo normalmente conserva título clean, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV para confirmarlo antes de adquirirlo.`;
      } else if (hasSalvageTrigger) {
        const triggerNames = damageList.filter(d => salvageTriggers.includes(d)).join(', ');
        salvageWarning = `Dado que presenta ${triggerNames}, existe la posibilidad de que al momento de registrar el vehículo el título cambie a salvage dependiendo del estado donde sea registrado. Recomendamos contactar al DMV local para confirmar esto antes de adquirirlo.`;
      }
    }

    const prompt = `Eres un broker experto de subastas de vehículos salvage (Copart, IAAI, Manheim). Redacta un análisis profesional en español para enviar por WhatsApp a un cliente. Debe ser CONCISO. Texto plano, sin markdown, sin asteriscos, sin guiones al inicio, sin emojis.

REGLAS IMPORTANTES:
- Varía el vocabulario y la estructura de las oraciones en cada análisis — nunca uses las mismas frases de siempre.
- Título Clean significa que NO fue declarado pérdida total por la aseguradora. NUNCA digas Salvage si el título es Clean. Explica solo que no fue declarado pérdida total.
- Título Salvage significa que el daño fue lo suficientemente severo para que la aseguradora lo declarara pérdida total — dilo con confianza.
- Los daños son REALES y CONFIRMADOS — afírmalos con seguridad, nunca uses "se menciona" ni "podría tener".
- NUNCA uses frases como "catalogado como tal", "sugiere", "se menciona", "podría indicar" para los daños visibles.
- NUNCA digas que el vehículo "rueda correctamente" ni uses la palabra "correctamente".
- NUNCA uses "Dado que presenta daño por Daño" — usa solo el tipo sin repetir la palabra daño.

Usa EXACTAMENTE esta estructura (respeta saltos de línea, NO modifiques los textos marcados INSERTAR TAL CUAL):

${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}
[2-3 oraciones: el título es "${titleType}" — si es Clean di que NO fue declarado pérdida total por la aseguradora, NUNCA menciones Salvage; si es Salvage di que el daño fue suficientemente severo para declararlo pérdida total. Afirma los daños "${damageTextClean}" con seguridad. Millas ${miles} (${milesStatus}). Estado general conciso.]
${tituloAusenteWarning ? `INSERTAR TAL CUAL: ${tituloAusenteWarning}` : ''}
${milesWarning ? `INSERTAR TAL CUAL: ${milesWarning}` : ''}
${salvageWarning ? `INSERTAR TAL CUAL: ${salvageWarning}` : ''}
${destructionWarning ? `INSERTAR TAL CUAL: ${destructionWarning}` : ''}
${copartGoWarning ? `INSERTAR TAL CUAL: ${copartGoWarning}` : ''}
${externalLotWarning ? `INSERTAR TAL CUAL: ${externalLotWarning}` : ''}
${lightsText ? `INSERTAR TAL CUAL: ${lightsText}` : `INSERTAR TAL CUAL: ${noLightsText}`}
${mechText ? `INSERTAR TAL CUAL: ${mechText}` : ''}
${observations ? `[Integra estas observaciones del broker de forma natural, SIN repetir lo que ya se mencionó arriba sobre daños, luces o estado mecánico: ${observations}]` : ''}

Ofertaría entre $${offerMin} a $${offerMax}
${buyNowText}${reserveText}

VIN: ${vin}
Solicite su REPORTE aquí:
${REPORT_LINK}

Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.
CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.7
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
