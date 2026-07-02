export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, fields } = req.body;
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(500).json({ error: 'API key no configurada' });

  // ---- MODO CARFAX ----
  if (mode === 'carfax') {
    const carfaxText = req.body.carfaxText || '';
    if (!carfaxText.trim()) return res.status(400).json({ error: 'Sin texto del Carfax' });
    try {
      const carfaxPrompt = `Eres un experto en análisis de reportes Carfax de vehículos de subasta. A continuación tienes el texto extraído de un reporte Carfax. Analízalo a fondo y genera un resumen profesional y COMPLETO en español para enviar por WhatsApp a un cliente. Texto plano, sin markdown, sin asteriscos, sin emojis.

Incluye SIEMPRE que aparezca en el reporte (no resumas de más, la información importante debe estar completa):

1. TIPO DE TÍTULO: indica claramente qué tipo de título reporta el Carfax (Clean, Salvage, Junk, Certificate of Destruction, Rebuilt, etc.) y explica brevemente qué significa. Recuerda atribuirlo siempre al reporte ("el Carfax indica...").

2. TOTAL LOSS: si el reporte menciona un "Total Loss" (pérdida total), DESTÁCALO. Explica que cuando una aseguradora declara total loss, el vehículo PODRÍA pasar a tener título salvage dependiendo del estado, aunque no siempre aplica. Recomienda verificar.

3. DUEÑOS ANTERIORES: cuántos dueños ha tenido.

4. ACCIDENTES: todos los accidentes o daños reportados con fechas si aparecen.

5. MILLAS / ODÓMETRO: registro de millas, y si hay alertas de rollback, inconsistencias o "not actual mileage".

6. HISTORIAL DE SERVICIOS: mantenimientos o servicios relevantes.

7. USO DEL VEHÍCULO: personal, alquiler, flota, comercial, etc.

8. ALERTAS: recompras (lemon/buyback), daños por inundación, granizo, robo recuperado, o cualquier problema serio.

Termina con un punto de vista honesto y profesional sobre lo que refleja el reporte en general.

REGLAS:
- Solo usa información que esté REALMENTE en el texto. NO inventes nada. Si algo no aparece, no lo menciones.
- No resumas en exceso: la información importante (título, total loss, accidentes, millas) debe quedar completa y clara.
- NO menciones que "el Carfax no reporta daños mecánicos" dentro del cuerpo del resumen; esa frase se agrega automáticamente al final una sola vez, no la incluyas tú.

Texto del Carfax:
${carfaxText.substring(0, 14000)}`;

      const cRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: carfaxPrompt }],
          max_tokens: 2000,
          temperature: 0.4
        })
      });
      const cData = await cRes.json();
      if (!cRes.ok) return res.status(500).json({ error: cData?.error?.message || 'Error de Groq' });
      let cText = (cData?.choices?.[0]?.message?.content || '').trim();
      cText = cText.replace(/^[\s\-–—•*>]+/, '').trim();
      // Quitar cualquier mención duplicada del disclaimer que la IA haya puesto
      cText = cText.replace(/\.?\s*(Recuerde que\s+)?El Carfax no reporta daños mecánicos ni ocultos\.?/gi, '').trim();
      // Agregar el disclaimer una sola vez al final
      cText += '\n\nRecuerde que el Carfax no reporta daños mecánicos ni ocultos.';
      return res.status(200).json({ result: cText });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const { lot, year, make, model, vin, titleType, auction, miles, milesStatus,
            damages, dashLights, dashCustom, observations, mechanicalStatus,
            offerMin, offerMax, buyNow, reservePrice, copartGo, externalLot, tituloAusente, fechaFuturo, excelente } = fields;

    const REPORT_LINK = 'https://t.me/reporteexpressbot';

    // ---- DAÑOS ----
    const damageList = Array.isArray(damages) && damages.length > 0 ? damages : [];
    const damageClean = damageList.join(', ').toLowerCase();

    // ---- ESTADO MECÁNICO ----
    const mechMap = {
      'no-enciende': 'El vehículo no enciende.',
      'solo-enciende': `${auction} verificó que el motor enciende, sin embargo no se confirma si el vehículo rueda.`,
      'enciende-no-rueda': `${auction} verificó que el motor enciende, sin embargo el vehículo no rueda, lo que podría indicar algún tipo de falla mecánica como transmisión u otro problema relacionado.`,
      'enciende-rueda': `${auction} verificó que el motor enciende y la transmisión engrana.`
    };
    const mechText = mechMap[mechanicalStatus] || '';

    // ---- LUCES ----
    const lightsMap = {
      'check-engine': 'Presenta la luz de check engine encendida, lo que podría indicar algún tipo de falla mecánica o electrónica.',
      'airbag': 'Presenta la luz de airbag/SRS encendida, lo que podría indicar detonación de airbags o falla en el sistema de seguridad.',
      'transmission': 'Presenta la luz de transmisión encendida, lo que podría indicar algún tipo de falla en la caja automática.',
      'abs': 'Presenta la luz de ABS encendida, lo que podría indicar algún tipo de falla en el sistema de frenos antibloqueo.',
      'battery': 'Presenta la luz de batería encendida, lo que podría indicar falla en el alternador, batería o sistema eléctrico.',
      'oil': 'Presenta la luz de aceite encendida, lo que podría indicar baja presión de aceite o falla en el sistema de lubricación.',
      'temperature': 'Presenta la luz de temperatura encendida, lo que podría indicar sobrecalentamiento del motor.',
      'multiple': 'Presenta múltiples luces del tablero encendidas, lo que podría indicar algún tipo de daño eléctrico o falla mecánica en el vehículo.',
      'custom': dashCustom ? `Presenta ${dashCustom} encendido, lo que podría indicar algún tipo de falla mecánica o electrónica.` : ''
    };
    const lightsArray = Array.isArray(dashLights) ? dashLights : (dashLights && dashLights !== 'none' ? [dashLights] : []);
    const lightsLines = lightsArray.map(l => lightsMap[l] || '').filter(Boolean);
    const lightsBlock = lightsLines.length > 0
      ? lightsLines.join(' ')
      : 'No presenta luces de motor ni airbag encendidas en el tablero.';

    // ---- MILLAS ----
    const milesMap = {
      'No actuales (TMU)': 'Las millas aparecen como No Actuales (TMU — True Mileage Unknown), lo que significa que las millas reales son desconocidas. Esto puede deberse a varias razones: que el odómetro haya sido modificado ilegalmente, que el vehículo sufriera un daño importante que impide comprobar el millaje, o una falla en el tablero. Considérelo al momento de evaluar el vehículo.',
      'Exentas': 'Las millas aparecen como Exentas (Exempt), lo que significa que legalmente no se puede certificar que el número del tablero sea el real. Generalmente ocurre porque al momento del accidente el vehículo quedó sin batería, el tablero se dañó, o la aseguradora no pudo encenderlo para verificar. No implica necesariamente fraude; muchas veces el número del tablero es cercano al real, pero por protección legal se procesa como Exento. Recomendamos revisar el Carfax para ver las millas del último servicio registrado.'
    };
    const milesWarning = milesMap[milesStatus] || '';

    // ---- SALVAGE WARNING (solo Clean) ----
    const isTitleClean = titleType === 'Clean';
    const hasHail = damageList.includes('Granizo');
    const salvageTriggers = ['Inundación/Agua', 'Vandalismo', 'Fuego'];
    const otherTriggers = damageList.filter(d => salvageTriggers.includes(d));
    const hasSalvageTrigger = otherTriggers.length > 0;
    let salvageWarning = '';
    if (isTitleClean) {
      if (hasHail && !hasSalvageTrigger) {
        const granizoVariants = [
          'El daño por granizo suele recibir automáticamente un título salvage al momento de registrarse. Sin embargo, en Texas normalmente conserva un título clean. Aun así, recomendamos contactar al DMV para confirmar si al momento de registrar el vehículo mantendría el título clean o si podría cambiar a salvage.',
          'Es importante tener en cuenta que el daño por granizo a menudo provoca que el título cambie a salvage al registrarlo, aunque en Texas suele mantenerse como clean. Le recomendamos verificar con el DMV de su estado si conservaría el título clean o pasaría a salvage.',
          'Tenga presente que en muchos estados el daño por granizo hace que el título pase a salvage durante el registro; Texas es una excepción donde normalmente se conserva clean. Por eso le sugerimos confirmar con el DMV cómo quedaría el título antes de adquirirlo.'
        ];
        salvageWarning = granizoVariants[Math.floor(Math.random() * granizoVariants.length)];
      } else if (hasHail && hasSalvageTrigger) {
        salvageWarning = `Dado que presenta granizo y ${otherTriggers.join(', ').toLowerCase()}, existe una alta probabilidad de que el título cambie a salvage al momento de registrarse, dependiendo del estado. En Texas el granizo normalmente conserva título clean, pero los daños adicionales pueden cambiar esto. Recomendamos contactar al DMV para confirmarlo antes de adquirirlo.`;
      } else if (hasSalvageTrigger) {
        salvageWarning = `Dado que presenta ${otherTriggers.join(', ').toLowerCase()}, existe la posibilidad de que al momento de registrar el vehículo el título cambie a salvage dependiendo del estado donde sea registrado. Recomendamos contactar al DMV local para confirmar esto antes de adquirirlo.`;
      }
    }

    // ---- DESTRUCTION ----
    const isDestruction = titleType === 'Certificate of Destruction / Junk';
    const destructionWarning = isDestruction
      ? 'Este vehículo posee un título Certificate of Destruction (Junk), lo que significa que JAMÁS podrá circular legalmente en las carreteras de Estados Unidos. Solo puede utilizarse para chatarra o venta de piezas.'
      : '';

    // ---- TOGGLES ----
    const tituloAusenteText = tituloAusente
      ? 'En cuanto al título: Copart no posee el título actualmente. Le da al vendedor 30 días hábiles para que sea enviado a la yarda y luego ellos deben enviárnoslo a FL.'
      : '';
    const copartGoText = copartGo
      ? 'Este vehículo está listado como CopartGO, lo que significa que fue publicado directamente por el vendedor usando la app móvil de Copart. El informe de condición lo completó el propio vendedor con respuestas de Sí/No y no representa la opinión de Copart, quien no inspeccionó el vehículo ni se hace responsable de la exactitud del informe.'
      : '';
    const externalLotText = externalLot
      ? 'Este es un Lote Externo: el vehículo no se encuentra físicamente en una ubicación de Copart. Está en una ubicación designada para previsualizar y retirar indicada en el lote.'
      : '';
    const fechaFuturoText = fechaFuturo
      ? 'Es posible que Copart haya realizado un cambio reciente en la fecha de subasta. Actualmente en nuestra plataforma puede aparecer una fecha estimada, pero si en Copart el lote figura como "Future" o "Upcoming Lot", significa que la subasta aún no tiene una fecha confirmada, generalmente porque están pendientes documentos o el título del vehículo. Le recomendamos verificar directamente en Copart. Una vez que la documentación esté completa, se asignará una fecha de subasta oficial y el lote estará disponible para ofertar.'
      : '';

    const excelenteVariants = [
      'El vehículo se observa en excelente estado, sin daños estéticos apreciables. Es una unidad impecable, muy bien cuidada y con una presentación sobresaliente.',
      'Se trata de un vehículo en condiciones excepcionales, sin golpes ni daños visibles en la carrocería. Una excelente oportunidad por su estado prácticamente impecable.',
      'El vehículo luce en muy buen estado general, sin daños estéticos notables. Es una unidad limpia, bien mantenida y con una apariencia excelente.',
      'Excelente unidad, se aprecia en óptimas condiciones tanto estéticas como generales, sin daños visibles. Un vehículo muy bien conservado.'
    ];
    const excelenteText = excelente
      ? excelenteVariants[Math.floor(Math.random() * excelenteVariants.length)]
      : '';

    // ---- OFERTA ----
    const offerText = (offerMin && offerMax) ? `Ofertaría entre $${offerMin} a $${offerMax}` : '';
    const buyNowText = buyNow ? `El vehículo tiene un precio de compra inmediata (Buy Now) de $${buyNow}, ese es el precio mínimo que acepta el vendedor para cerrar la venta de inmediato.` : '';
    const reserveText = reservePrice ? `Tiene un precio de reserva de $${reservePrice}.` : '';

    // Solo la primera línea la genera la IA para dar variedad; el resto es fijo y controlado.
    const milesInline = miles ? `, con ${miles} millas ${milesStatus.toLowerCase()}` : '';
    const damageInline = damageClean ? ` Presenta daño por ${damageClean}.` : '';

    const titleExplain = {
      'Clean': 'no fue declarado pérdida total por la aseguradora',
      'Salvage': 'el daño fue lo suficientemente severo para que la aseguradora lo declarara pérdida total',
      'Rebuilt': 'fue reconstruido tras haber tenido un título salvage y aprobó la inspección estatal',
      'Parts Only': 'solo puede usarse para piezas, no puede registrarse para circular',
      'Certificate of Destruction / Junk': 'no puede circular legalmente, solo sirve para chatarra o piezas'
    };

    const prompt = `Eres un broker de subastas de vehículos. Redacta SOLO el primer párrafo de un análisis, en español, en una a dos oraciones. Texto plano, sin markdown, sin emojis.

IMPORTANTE: Varía SIEMPRE la estructura y el vocabulario. Cada vez que generes este párrafo debe sonar diferente al anterior — cambia el orden de las ideas, usa sinónimos, varía cómo introduces el título y los daños. Nunca repitas la misma redacción.

Datos:
- Título: ${titleType} (significa: ${titleExplain[titleType] || ''})
- Daños: ${damageClean || 'ninguno especificado'}
${miles ? `- Millas: ${miles} ${milesStatus.toLowerCase()}` : '- Millas: no especificadas (NO las menciones)'}

Reglas:
- Empieza indicando el título sin afirmarlo con certeza absoluta, atribuyéndolo a la subasta. VARÍA la forma de decirlo cada vez, usa diferentes opciones como: "La subasta indica título ${titleType}", "El lote figura con título ${titleType}", "De acuerdo a la subasta, el título es ${titleType}", "Copart reporta título ${titleType}", "El vehículo aparece listado con título ${titleType}", "Registrado en la subasta como título ${titleType}". NUNCA uses siempre la misma frase, NUNCA digas "El título de ${titleType}".
- Al explicar el significado del título, SIEMPRE atribúyelo a la subasta, nunca lo afirmes como un hecho propio. Usa fórmulas como "según Copart, este título indica que...", "de acuerdo a la información de la subasta, esto significa que...". Para Salvage: "según la subasta, este título indica que el vehículo habría sufrido un daño suficientemente severo para ser declarado pérdida total". Siempre dejamos claro que solo repetimos la información de la subasta, no la verificamos nosotros.
- Afirma los daños con seguridad, nunca digas "sugiere" o "podría tener daños".
- Menciona los daños tal como están escritos, de forma natural: si dice "daño trasero" escribe "daño trasero" (NO "daño en el trasero"), si dice "granizo" escribe "daño por granizo". Para varios: "daño frontal y lateral".
- NO inventes datos ni agregues frases de relleno como "es beneficioso al vender", "proporciona una visión clara", "es un factor importante a considerar", "ofrece un atractivo precio de compra", "sin otros daños reportados", "su historial no presenta registros" o "puede necesitar reparaciones". NUNCA hables de historial ni reportes previos, no tenemos esa información.
- NO menciones fecha de subasta, luces, ni nada que no esté en los datos.
- Devuelve SOLO ese párrafo, nada más.`;

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 1.0
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data?.error?.message || 'Error de Groq' });
    let firstParagraph = (data?.choices?.[0]?.message?.content || '').trim();
    // Limpiar guiones, viñetas o caracteres sueltos al inicio
    firstParagraph = firstParagraph.replace(/^[\s\-–—•*>]+/, '').trim();

    // Mejorar observaciones con IA si existen (segunda llamada corta)
    let obsText = '';
    if (observations && observations.trim()) {
      const obsRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: `Mejora solo la redacción de esta observación de un broker de autos, en español, sin agregar nada nuevo, en una oración profesional. Devuelve solo la oración mejorada: "${observations}"` }],
          max_tokens: 150,
          temperature: 0.5
        })
      });
      const obsData = await obsRes.json();
      if (obsRes.ok) obsText = (obsData?.choices?.[0]?.message?.content || '').trim().replace(/^["']|["']$/g, '');
    }

    // ---- ENSAMBLAR EL TEXTO FINAL (controlado) ----
    const header = `${lot} - ${year} ${make.toUpperCase()} ${model.toUpperCase()}`;

    const blocks = [
      firstParagraph,
      tituloAusenteText,
      milesWarning,
      salvageWarning,
      destructionWarning,
      copartGoText,
      externalLotText,
      fechaFuturoText,
      excelenteText,
      lightsBlock,
      mechText,
      obsText,
    ].filter(Boolean);

    const offerBlock = [offerText, buyNowText, reserveText].filter(Boolean).join('\n');

    const footer = `VIN: ${vin}
Solicite su REPORTE aquí:
${REPORT_LINK}

Es siempre recomendable revisar el Reporte de Carfax para verificar el tipo de título, millas, servicios realizados, accidentes reportados, y propietarios anteriores.

CARFAX NO DA INFORMACIÓN DE DAÑOS MECÁNICOS NI OCULTOS`;

    let result = header + '\n' + blocks.join('\n\n');
    if (offerBlock) result += '\n\n' + offerBlock;
    result += '\n\n' + footer;

    // Eliminar líneas que sean solo un guion/viñeta suelto
    result = result
      .split('\n')
      .filter(line => !/^\s*[-–—•*]+\s*$/.test(line))
      .join('\n')
      .trim();

    return res.status(200).json({ result });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
