// デモ用のモデル: 電圧源（振幅 V）で駆動した直列 RLC。
//
// random-plot2d に渡す model の書き方の見本でもある。変数の並びが x の添字、
// 関数の並びが y の添字になる。eval は y を全部書くこと。
const model = {
  name: '直列 RLC（デモ）',
  vars: [
    {id:'V', label:'V', unit:'V',  value:1,     dist:'lin', min:0,    max:10},
    {id:'R', label:'R', unit:'Ω',  value:10,    dist:'log', min:0.1,  max:1e3},
    {id:'L', label:'L', unit:'H',  value:100e-6, dist:'log', min:1e-6, max:10e-3},
    {id:'C', label:'C', unit:'F',  value:100e-9, dist:'log', min:1e-9, max:10e-6},
    // 周波数だけは初めから幅を持たせておく（ほかは幅 0 = 固定値から始まる）
    {id:'f', label:'f', unit:'Hz', value:50e3,  dist:'log', min:1,    max:1e8, lo:10e3, hi:200e3},
  ],
  outs: [
    {id:'Zabs', label:'|Z|',      unit:'Ω',  scale:'log'},
    {id:'phase',label:'∠Z',       unit:'°',  scale:'lin'},
    {id:'Iabs', label:'|I|',      unit:'A',  scale:'log'},
    {id:'P',    label:'P(R)',     unit:'W',  scale:'log'},
    {id:'f0',   label:'f0',       unit:'Hz', scale:'log'},
    {id:'Q',    label:'Q',        unit:'',   scale:'log'},
  ],
  eval(x, y){
    const V = x[0], R = x[1], L = x[2], C = x[3], f = x[4];
    const w = 2*Math.PI*f;
    const X = w*L - 1/(w*C);
    const Z = Math.hypot(R, X);
    const I = V/Z;
    y[0] = Z;
    y[1] = Math.atan2(X, R)*180/Math.PI;
    y[2] = I;
    y[3] = 0.5*I*I*R;
    y[4] = 1/(2*Math.PI*Math.sqrt(L*C));
    y[5] = Math.sqrt(L/C)/R;
  },
};
