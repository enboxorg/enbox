declare module 'recharts' {
  import { ComponentType, ReactElement } from 'react';

  export interface PieChartProps {
    width?: number;
    height?: number;
    children?: React.ReactNode;
  }

  export interface PieProps {
    data: any[];
    cx?: string | number;
    cy?: string | number;
    outerRadius?: number;
    fill?: string;
    dataKey: string;
    label?: boolean | ((props: any) => string) | ReactElement;
    labelLine?: boolean;
    children?: React.ReactNode;
  }

  export interface CellProps {
    fill?: string;
  }

  export interface TooltipProps {
    active?: boolean;
    payload?: any[];
    label?: string;
  }

  export interface ResponsiveContainerProps {
    width?: string | number;
    height?: string | number;
    children?: React.ReactNode;
  }

  export const PieChart: ComponentType<PieChartProps>;
  export const Pie: ComponentType<PieProps>;
  export const Cell: ComponentType<CellProps>;
  export const Tooltip: ComponentType<TooltipProps>;
  export const ResponsiveContainer: ComponentType<ResponsiveContainerProps>;
}